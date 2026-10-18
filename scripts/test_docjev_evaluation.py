"""Offline regression tests: diagnostic classifier must never expose provider bodies."""
import importlib.util
import pathlib
import urllib.error
from unittest.mock import patch
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "docjev-evaluation.py"
spec = importlib.util.spec_from_file_location("docjev_evaluation", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class DiagnosticTests(unittest.TestCase):
    def test_missing_key_avoids_network(self):
        with patch.object(mod.urllib.request, "build_opener") as opener:
            self.assertEqual(mod.check_openrouter_key(""), {"category": "missing_credential"})
            opener.assert_not_called()

    def test_key_rejection_has_no_secret_in_report(self):
        class Opener:
            def open(self, req, timeout):
                raise urllib.error.HTTPError(req.full_url, 401, "secret-in-body", {}, None)
        with patch.object(mod.urllib.request, "build_opener", return_value=Opener()):
            result = mod.check_openrouter_key("sk-or-test-secret")
        self.assertEqual(result, {"category": "key_rejected", "httpStatus": 401})
        self.assertNotIn("sk-or-test-secret", str(result))

    def test_authentication_status(self):
        self.assertEqual(mod.sanitized_failure("Jev request failed (401). Check access, limits, or connectivity."),
                         {"category": "authentication", "httpStatus": 401})

    def test_rate_limit(self):
        self.assertEqual(mod.sanitized_failure("Jev request failed (429)."),
                         {"category": "rate_limit", "httpStatus": 429})

    def test_provider_failure(self):
        self.assertEqual(mod.sanitized_failure("Jev request failed (503)."),
                         {"category": "provider_unavailable", "httpStatus": 503})

    def test_unknown_is_redacted(self):
        secret = "sk-or-test-secret"
        self.assertEqual(mod.sanitized_failure("Provider error: " + secret),
                         {"category": "unknown"})
        self.assertNotIn(secret, str(mod.sanitized_failure(secret)))


if __name__ == "__main__":
    unittest.main()
