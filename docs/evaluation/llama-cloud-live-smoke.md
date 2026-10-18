# LlamaCloud live smoke findings

**Observed:** 2026-10-18 UTC
**Inputs:** synthetic digital USD invoice, synthetic COP cuenta de cobro, synthetic PNG invoice scan
**Purpose:** validate the opt-in LlamaParse/LlamaExtract adapter; this is not production or human-annotation evidence.

## Result

The first run parsed the two PDFs through LlamaExtract's bundled parse step, but returned citations that could not be matched to Praeco's retained page text. Both results remained `REVIEW_REQUIRED`. The standalone PNG upload failed with HTTP 415 before processing.

The adapter was changed to:

- use LlamaParse first and pass the completed Parse job ID to Extract, so citations refer to the retained Parse text;
- use `.png` / `.jpg` upload filenames instead of the generic `.img` suffix;
- use the cost-effective Parse and Extract tiers; and
- include Parse usage from the nested `job.usage` field in smoke reports.

The second run parsed all three inputs, including the PNG. Extract still returned citation `matching_text` values such as `invoices.0.currency`, which do not occur in the retained Parse text. Praeco correctly rejected those citations. The two PDFs and the scan all remained `REVIEW_REQUIRED`; the scan also reported `OCR_FIDELITY_UNVERIFIED`.

| Input | Parse | Extract | Provider credits | Praeco result |
|---|---:|---:|---:|---|
| Digital USD invoice | 3 | 5 | 8 | `REVIEW_REQUIRED`; citation grounding failed |
| COP cuenta de cobro | 3 | 5 | 8 | `REVIEW_REQUIRED`; citation grounding failed |
| PNG scan | 3 | 5 | 8 | `REVIEW_REQUIRED`; OCR fidelity and citation grounding failed |

The corrected run used **24 credits**. The initial run used **50 credits** for two Extract jobs; the PNG request was rejected before billing. Total observed usage was **74 credits**, equivalent to **US$0.0925** at the published rate of US$1.25 per 1,000 credits. This was drawn from the free credit allowance; no direct payment was made.

## Recheck after adapter updates

A third run on October 18 UTC again processed the three synthetic inputs for **24 credits** (3 Parse + 5 Extract per input). None matched the fixture's expected invoice fields. All remained `REVIEW_REQUIRED`; both PDFs additionally had no observed currency, so normalization was unavailable. Every result included `UNCITED_PROVIDER_VALUE` and `CRITICAL_OR_CONFLICTING_FIELD`; the scan also included `OCR_FIDELITY_UNVERIFIED`. The smoke command correctly exited nonzero because expected fields and PDF dispositions did not match.

## Decision

LlamaParse is provisioned and processed the three synthetic inputs at the cost-effective tier. LlamaExtract is **not validated for Praeco readiness**: all its fields must remain candidates for human review until its citations can be grounded against source text. Do not weaken the verifier or treat confidence scores as evidence. For the hackathon demo, use Praeco's deterministic synthetic extractor for the labelled fixture corpus and show hosted results as pending review.

No real customer or company documents were sent. No financial decision or payment was made. Independent human annotation and broader provider quality validation remain pending.
