#!/usr/bin/env python3
"""Synthetic-only DocJev experiment, no L1 runtime changes.

Modes: preflight (no remote inference) or live (at most two Jev calls).
Only explicitly selected repo fixtures are eligible; no arbitrary document paths.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "packages/evidence-intelligence/test/fixtures/corpus"
RULES = ROOT / "docs/evaluation/docjev-rules.yaml"
SELECTED = {"01.pdf": "invoice", "02.pdf": "invoice"}
MODEL = "jev-1.14"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["preflight", "live"], default="preflight")
    parser.add_argument("--docjev-root", type=Path, required=True)
    args = parser.parse_args()
    docjev = args.docjev_root.resolve()
    executable = [sys.executable, "-m", "jev_docs.cli"]
    if args.mode == "live" and not os.environ.get("TYPESAFE_API_KEY"):
        raise SystemExit("TYPESAFE_API_KEY is required for live inference.")
    results = []
    for filename, expected in SELECTED.items():
        source = FIXTURES / filename
        if not source.is_file():
            raise SystemExit(f"Fixture unavailable: {filename}")
        if args.mode == "preflight":
            cmd = executable + ["parse", str(source), "--ocr", "liteparse"]
        else:
            cmd = executable + ["classify", str(source), "--rules", str(RULES), "--engine", "jev", "--model", MODEL]
        run = subprocess.run(cmd, cwd=docjev, capture_output=True, text=True, timeout=150, check=False)
        if run.returncode:
            results.append({"file": filename, "status": "error", "error": "DocJev invocation failed", "exitCode": run.returncode})
            continue
        try:
            obj = json.loads(run.stdout)
            if args.mode == "preflight":
                actual = "parse_completed" if isinstance(obj, dict) else "invalid"
                ok = actual == "parse_completed"
            else:
                actual = obj.get("category") if isinstance(obj, dict) else None
                ok = actual == expected
            results.append({"file": filename, "status": "pass" if ok else "mismatch",
                            "expected": expected if args.mode == "live" else "parse_completed",
                            "actual": actual, "needsReview": obj.get("needs_review") if isinstance(obj, dict) else None})
        except (ValueError, AttributeError):
            results.append({"file": filename, "status": "invalid_output"})
    print(json.dumps({"mode": args.mode, "model": MODEL if args.mode == "live" else None,
                      "provider": "OpenRouter" if args.mode == "live" else "none",
                      "attempted": len(SELECTED), "results": results,
                      "independentHumanAnnotation": False,
                      "fieldLevelAccuracyEvaluated": False}, indent=2))
    if any(r["status"] != "pass" for r in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
