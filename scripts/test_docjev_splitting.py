"""Offline Jev packet benchmark tests. No network or provider inference."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("docjev_split_benchmark", Path(__file__).with_name("docjev-splitting-benchmark.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)

EXPECTED = (("invoice", (1, 2)), ("invoice", (3, 4)))

def segment(category, pages, review=False):
    return {"category": category, "pages": pages, "needs_review": review}

def result(segments, count=4, warnings=None):
    return {"task": "split", "document": {"page_count": count}, "segments": segments, "warnings": warnings or []}

class SplitBenchmarkTests(unittest.TestCase):
    def test_exact(self):
        r = benchmark.score_split(result([segment("invoice", [1, 2]), segment("invoice", [3, 4])]), EXPECTED)
        self.assertEqual((r["status"], r["boundaryTP"], r["correctPageCategories"]), ("pass", 1, 4))

    def test_false_boundary(self):
        r = benchmark.score_split(result([segment("invoice", [1]), segment("invoice", [2]), segment("invoice", [3, 4])]), EXPECTED)
        self.assertEqual((r["status"], r["boundaryFP"]), ("mismatch", 1))

    def test_missed_boundary(self):
        r = benchmark.score_split(result([segment("invoice", [1, 2, 3, 4])]), EXPECTED)
        self.assertEqual((r["status"], r["boundaryFN"]), ("mismatch", 1))

    def test_category_mismatch(self):
        r = benchmark.score_split(result([segment("invoice", [1, 2]), segment("contract", [3, 4])]), EXPECTED)
        self.assertEqual((r["status"], r["correctPageCategories"]), ("mismatch", 2))

    def test_review_signal_never_passes(self):
        r = benchmark.score_split(result([segment("invoice", [1, 2], True), segment("invoice", [3, 4])]), EXPECTED)
        self.assertEqual(r["status"], "review_required")

    def test_warning_never_passes(self):
        r = benchmark.score_split(result([segment("invoice", [1, 2]), segment("invoice", [3, 4])], warnings=["boundary conflict"]), EXPECTED)
        self.assertEqual(r["status"], "review_required")

    def test_gap_and_overlap_fail_closed(self):
        for segments in ([segment("invoice", [1]), segment("invoice", [3, 4])],
                         [segment("invoice", [1, 2]), segment("invoice", [2, 3, 4])]):
            with self.subTest(segments=segments):
                self.assertEqual(benchmark.score_split(result(segments), EXPECTED)["status"], "invalid_coverage")

    def test_noncontiguous_pages_fail_closed(self):
        r = benchmark.score_split(result([segment("invoice", [1, 3]), segment("invoice", [2, 4])]), EXPECTED)
        self.assertEqual(r["status"], "invalid_contiguity")

    def test_unknown_category_fails_closed(self):
        r = benchmark.score_split(result([segment("pay_now", [1, 2]), segment("invoice", [3, 4])]), EXPECTED)
        self.assertEqual(r["status"], "invalid_segment")

    def test_document_page_count_mismatch(self):
        r = benchmark.score_split(result([segment("invoice", [1, 2]), segment("invoice", [3, 4])], count=5), EXPECTED)
        self.assertEqual(r["status"], "invalid_document")

    def test_parse_page_coverage(self):
        r = benchmark.score_parse({"page_count": 3, "pages": [{"number": 1}, {"number": 3}, {"number": 3}]}, 3)
        self.assertEqual(r["status"], "invalid_pages")

    def test_missing_key_skips_live_invocations(self):
        with patch.dict("os.environ", {"TYPESAFE_API_KEY": ""}), patch.object(benchmark, "generate_packets") as generate:
            report, ok = benchmark.run("live", Path("."))
        self.assertFalse(ok)
        self.assertEqual(report["jevInvocations"], 0)
        generate.assert_not_called()

    def test_generated_packet_lengths(self):
        from pypdf import PdfReader
        with tempfile.TemporaryDirectory() as directory:
            benchmark.generate_packets(Path(directory))
            self.assertEqual(len(PdfReader(str(Path(directory) / "continuation.pdf")).pages), 4)
            self.assertEqual(len(PdfReader(str(Path(directory) / "mixed.pdf")).pages), 3)

if __name__ == "__main__":
    unittest.main()
