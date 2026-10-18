#!/usr/bin/env python3
"""Synthetic-only Jev 1.14 packet-splitting benchmark; never enters authoritative L1."""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "packages/evidence-intelligence/test/fixtures/corpus"
RULES = ROOT / "docs/evaluation/docjev-rules.yaml"
MODEL = "jev-1.14"
CATEGORIES = {"invoice", "contract", "supplemental_context", "other"}
# Evaluation-only machine-authored labels; never provider input.
SAMPLES = (
    ("corpus-18", "18.pdf", (("invoice", (1,)), ("invoice", (2,)))),
    ("corpus-19", "19.pdf", (("invoice", (1,)), ("invoice", (2,)))),
    ("corpus-20", "20.pdf", (("invoice", (1,)), ("invoice", (2,)))),
    ("continuation", "continuation.pdf", (("invoice", (1, 2)), ("invoice", (3, 4)))),
    ("mixed", "mixed.pdf", (("invoice", (1,)), ("contract", (2,)), ("invoice", (3,)))),
)

def generate_packets(folder):
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.lib.pagesizes import letter
    packets = {
        "continuation.pdf": (
            ["INVOICE A", "Invoice Number: SYN-A-2026", "Vendor: Synthetic Alpha",
             "October engineering services USD 1200", "Itemized work continues on next page."],
            ["CONTINUATION OF INVOICE A", "Same invoice SYN-A-2026 from previous page",
             "Engineering milestone 1, milestone 2", "Not a new request for payment."],
            ["INVOICE B", "Invoice Number: SYN-B-2026", "Vendor: Synthetic Beta",
             "October cloud hosting services USD 480", "Itemized work continues on next page."],
            ["CONTINUATION OF INVOICE B", "Same invoice SYN-B-2026 from previous page",
             "Compute and storage details", "Not a new request for payment."]),
        "mixed.pdf": (
            ["INVOICE C", "Invoice Number: SYN-C-2026", "Vendor: Synthetic Gamma",
             "Services delivered October", "Amount due USD 800; please remit payment."],
            ["SERVICE CONTRACT 72", "Agreement between Demo Company and Synthetic Gamma",
             "Effective 2026-01-01; terms and obligations only",
             "This contract does not request any payment."],
            ["INVOICE D", "Invoice Number: SYN-D-2026", "Vendor: Synthetic Delta",
             "Services delivered October", "Amount due USD 650; please remit payment."]),
    }
    for name, pages in packets.items():
        pdf = Canvas(str(folder / name), pagesize=letter, invariant=1, pageCompression=0)
        pdf.setAuthor("Praeco synthetic evaluation")
        for lines in pages:
            for i, line in enumerate(lines):
                pdf.setFont("Helvetica", 11)
                pdf.drawString(50, 745 - 25*i, line)
            pdf.showPage()
        pdf.save()

def score_split(response, expected):
    """Reject missing/overlapping pages, noncontiguous segments and review warnings."""
    total = sum(len(pages) for _, pages in expected)
    document = response.get("document")
    segments = response.get("segments")
    if response.get("task") != "split" or not isinstance(document, dict) or document.get("page_count") != total:
        return {"status": "invalid_document"}
    if not isinstance(segments, list) or not segments:
        return {"status": "invalid_segments"}
    actual = []
    reviews = 0
    for segment in segments:
        if not isinstance(segment, dict):
            return {"status": "invalid_segment"}
        category, pages = segment.get("category"), segment.get("pages")
        if category not in CATEGORIES or not isinstance(pages, list) or not pages or any(type(p) is not int for p in pages):
            return {"status": "invalid_segment"}
        if pages != list(range(pages[0], pages[-1]+1)):
            return {"status": "invalid_contiguity"}
        actual.append((category, tuple(pages)))
        reviews += bool(segment.get("needs_review") or category == "other")
    if [p for _, pages in actual for p in pages] != list(range(1, total+1)):
        return {"status": "invalid_coverage"}
    expected_boundaries = {ps[0] for _, ps in expected if ps[0] != 1}
    predicted_boundaries = {ps[0] for _, ps in actual if ps[0] != 1}
    correct_pages = sum(a == b for (_, ea), (_, pa) in zip(
        [(p, c) for c, ps in expected for p in ps],
        [(p, c) for c, ps in actual for p in ps]) for a, b in [(ea, pa)])
    warnings = response.get("warnings")
    warning_count = len(warnings) if isinstance(warnings, list) else 0
    exact = tuple(actual) == expected
    status = "review_required" if reviews or warning_count else "pass" if exact else "mismatch"
    metrics = response.get("metrics") if isinstance(response.get("metrics"), dict) else {}
    return {
        "status": status, "exactPacket": exact, "pageCount": total,
        "predicted": [{"category": c, "pages": list(ps)} for c, ps in actual],
        "correctPageCategories": correct_pages,
        "boundaryTP": len(predicted_boundaries & expected_boundaries),
        "boundaryFP": len(predicted_boundaries - expected_boundaries),
        "boundaryFN": len(expected_boundaries - predicted_boundaries),
        "reviewSegments": reviews, "warnings": warning_count,
        "decisionMs": metrics.get("decision_ms") if isinstance(metrics.get("decision_ms"), (int, float)) else None,
        "decisionCostUsd": metrics.get("decision_cost_usd") if isinstance(metrics.get("decision_cost_usd"), (int, float)) else None,
    }

def score_parse(response, count):
    pages = response.get("pages")
    if response.get("page_count") != count or not isinstance(pages, list) or len(pages) != count:
        return {"status": "invalid_parse"}
    if any(not isinstance(p, dict) for p in pages) or [p["number"] for p in pages] != list(range(1, count+1)):
        return {"status": "invalid_pages"}
    return {"status": "pass", "pageCount": count}

def invoke(root, arguments):
    try:
        proc = subprocess.run([sys.executable, "-m", "jev_docs.cli", *arguments],
                              cwd=root, text=True, capture_output=True, timeout=150, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return {"error": "timeout_or_execution_failure"}
    if proc.returncode:
        status = re.search(r"Jev request failed \((\d{3})\)", proc.stderr)
        return {"error": "docjev_failure", **({"httpStatus": int(status.group(1))} if status else {})}
    try:
        obj = json.loads(proc.stdout)
        return {"result": obj} if isinstance(obj, dict) else {"error": "invalid_json"}
    except ValueError:
        return {"error": "invalid_json"}

def key_accepted():
    key = os.getenv("TYPESAFE_API_KEY", "").strip()
    if not key:
        return False
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    req = urllib.request.Request("https://openrouter.ai/api/v1/key",
                                 headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=10) as reply:
            return reply.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False

def run(mode, docjev):
    if mode == "live" and not key_accepted():
        return {"mode": mode, "authentication": "rejected_or_unavailable", "jevInvocations": 0}, False
    rows = []
    with tempfile.TemporaryDirectory(prefix="praeco-synthetic-docjev-") as directory:
        folder = Path(directory)
        generate_packets(folder)
        for sid, filename, expected in SAMPLES:
            pdf = (CORPUS / filename if sid.startswith("corpus") else folder / filename).resolve()
            if not pdf.is_file():
                rows.append({"sample": sid, "status": "fixture_missing"})
                break
            arguments = (["parse", str(pdf), "--ocr", "liteparse"] if mode == "preflight" else
                         ["split", str(pdf), "--rules", str(RULES), "--ocr", "liteparse", "--engine", "jev", "--model", MODEL])
            raw = invoke(docjev, arguments)
            if "error" in raw:
                rows.append({"sample": sid, "status": raw["error"], **({"httpStatus": raw["httpStatus"]} if "httpStatus" in raw else {})})
                break
            expected_pages = sum(len(ps) for _, ps in expected)
            scored = score_parse(raw["result"], expected_pages) if mode == "preflight" else score_split(raw["result"], expected)
            rows.append({"sample": sid, **scored})
            if scored["status"].startswith("invalid"):
                break
    report = {
        "mode": mode, "model": MODEL if mode == "live" else None,
        "dataset": "synthetic_only", "independentHumanAnnotation": False,
        "eligiblePackets": len(SAMPLES), "evaluatedPackets": len(rows),
        "jevInvocations": len(rows) if mode == "live" else 0,
        "exactPackets": sum(bool(row.get("exactPacket")) for row in rows),
        "reviewPackets": sum(row["status"] == "review_required" for row in rows),
        "boundaryTP": sum(row.get("boundaryTP", 0) for row in rows),
        "boundaryFP": sum(row.get("boundaryFP", 0) for row in rows),
        "boundaryFN": sum(row.get("boundaryFN", 0) for row in rows),
        "fieldLevelAccuracyEvaluated": False, "financialAuthorizationPerformed": False,
        "results": rows,
    }
    return report, len(rows) == len(SAMPLES) and all(row["status"] == "pass" for row in rows)

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--docjev-root", type=Path, required=True)
    p.add_argument("--mode", choices=("preflight", "live"), default="preflight")
    args = p.parse_args()
    report, passed = run(args.mode, args.docjev_root.resolve())
    print(json.dumps(report, indent=2))
    if not passed:
        raise SystemExit(1)
