#!/usr/bin/env python3
"""Synthetic-only DocJev experiment, no L1 runtime changes.

Modes: preflight (no remote inference) or live (at most two Jev calls).
Only explicitly selected repo fixtures are eligible; no arbitrary document paths.
"""
import argparse
import json
import os
import subprocess
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "packages/evidence-intelligence/test/fixtures/corpus"
RULES = ROOT / "docs/evaluation/docjev-rules.yaml"
SELECTED = {"01.pdf": "invoice", "02.pdf": "invoice"}
MODEL = "jev-1.14"

def sanitized_failure(stderr: str) -> dict:
    """Emit only a numeric status and a bounded failure class, never response text."""
    match = re.search(r"Jev request failed \((\d{3})\)", stderr)
    if match:
        status = int(match.group(1))
        category = ("authentication" if status in (401, 403) else
                    "rate_limit" if status == 429 else
                    "request_rejected" if 400 <= status < 500 else
                    "provider_unavailable" if status >= 500 else "unknown")
        return {"category": category, "httpStatus": status}
    if "ContextLimitError" in stderr or "input size" in stderr:
        return {"category": "context_limit"}
    if "invalid category decision" in stderr or "incomplete answer set" in stderr:
        return {"category": "invalid_provider_response"}
    if "unreadable response" in stderr:
        return {"category": "invalid_provider_response"}
    if "ConnectionError" in stderr or "Timeout" in stderr:
        return {"category": "network_or_timeout"}
    if "Unknown model" in stderr or "not supported" in stderr:
        return {"category": "model_or_protocol"}
    if "TYPESAFE_API_KEY" in stderr:
        return {"category": "missing_credential"}
    return {"category": "unknown"}



KEY_INFO_URL = "https://openrouter.ai/api/v1/key"

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Prevent accidentally forwarding credentials to a redirected host."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def check_openrouter_key(api_key: str) -> dict:
    """Validate key using read-only OpenRouter endpoint, without exposing responses."""
    if not api_key:
        return {"category": "missing_credential"}
    request = urllib.request.Request(
        KEY_INFO_URL,
        headers={"Authorization": "Bearer " + api_key.strip(), "Accept": "application/json"},
        method="GET",
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=10) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
    except (urllib.error.URLError, TimeoutError, OSError):
        return {"category": "network_or_timeout"}
    if status == 200:
        return {"category": "key_accepted", "httpStatus": 200}
    if status == 401:
        return {"category": "key_rejected", "httpStatus": 401}
    if status == 403:
        return {"category": "key_forbidden", "httpStatus": 403}
    if status == 429:
        return {"category": "rate_limit", "httpStatus": 429}
    if 500 <= status < 600:
        return {"category": "provider_unavailable", "httpStatus": status}
    return {"category": "unexpected_http_status", "httpStatus": status}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["preflight", "auth", "live"], default="preflight")
    parser.add_argument("--docjev-root", type=Path, required=True)
    args = parser.parse_args()
    docjev = args.docjev_root.resolve()
    executable = [sys.executable, "-m", "jev_docs.cli"]
    if args.mode in {"auth", "live"}:
        auth = check_openrouter_key(os.environ.get("TYPESAFE_API_KEY", ""))
        if args.mode == "auth" or auth.get("category") != "key_accepted":
            print(json.dumps({"mode": args.mode, "provider": "OpenRouter",
                              "authentication": auth, "jevCalls": 0,
                              "note": "Key validation does not prove Jev route access."}, indent=2))
            if auth.get("category") != "key_accepted":
                raise SystemExit(1)
            return
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
            results.append({"file": filename, "status": "error", "error": "DocJev invocation failed",
                            "exitCode": run.returncode, "diagnostic": sanitized_failure(run.stderr)})
            # Stop after the first failure to minimize paid retries and avoid repetitive billing.
            break
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
                      "attempted": len(results), "eligible": len(SELECTED), "results": results,
                      "independentHumanAnnotation": False,
                      "fieldLevelAccuracyEvaluated": False}, indent=2))
    if any(r["status"] != "pass" for r in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
