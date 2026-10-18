# L1 — Jev/DocJev synthetic packet-splitting benchmark

**Status:** Experimental; no L1, L2, or L3 runtime modifications. Tests and model inference must be verified after PR review.

## Goal and source controls

Expand the successful 2/2 invoice-classification live smoke (run 39093326642) with actual packet-boundary evaluation. The existing DocJev rules cover invoice, contract, supplemental context, and other. Only synthetic sources are eligible. All expected categories and boundaries are **machine-authored evaluation labels** and NOT independently human-annotated.

| Sample | Input | Expected contiguous segments |
| --- | --- | --- |
| corpus-18 | Existing corpus/18.pdf | invoice p1; invoice p2 |
| corpus-19 | Existing corpus/19.pdf | invoice p1; invoice p2 |
| corpus-20 | Existing corpus/20.pdf | invoice p1; invoice p2 |
| continuation | Generated synthetic four-page PDF | invoice p1–2; invoice p3–4 |
| mixed | Generated synthetic three-page PDF | invoice p1; contract p2; invoice p3 |

Generated PDFs are ephemeral local fixtures, never committed. The existing 18–20 are two one-page invoice packets, not tests of continuation detection.

## Controlled execution

Workflow: `.github/workflows/l1-docjev-splitting.yml`, triggered manually on `main` after merge.

- `preflight`: parse all five synthetic PDFs with LiteParse only; no Jev model calls and no key injection. Validate original page count/order.
- `live`: first query OpenRouter's read-only key validation; then invoke DocJev `split` once per packet with Jev 1.14, sequentially, up to five CLI invocations. **One CLI invocation may result in multiple provider requests and SDK retries; this is not a billing cap.** Do not run without separate approval.
- Upstream DocJev Git revision is pinned to `c7abe276a970605feb9cb8b27513365b6c10726e`. Dependencies are upstream-bounded, not fully locked.
- The runner captures raw child stdout and stderr but emits only sanitized packet IDs, categories, page indexes, TP/FP/FN counts, review counts, provider-reported model decision time/cost, and bounded failure categories. Neither document text nor credentials are output.

Every original page must be accounted for exactly once; overlapping/missing pages, invalid categories, extra/missed boundaries, or review flags make the live benchmark nonpassing. Negative results remain useful evaluation evidence. Target: 5/5 exact packets with zero unresolved reviews. One synthetic run cannot establish production segmentation quality.

## Next PRs and non-goals

PR B (conditional on empirical evidence) creates a typed adapter for DocJev decisions with strict source/page/tenant validation and bounded subprocess errors. PR C integrates reviewed segmentation proposals into L1 extraction and L3 Vera orchestration, preserving source hashes and original-page citations. Classification probabilities never imply L1 READY or L2 authorization. Human review remains mandatory for uncertain segments.

This benchmark does not measure field-level precision/recall or the pending hosted LlamaCloud smoke.
