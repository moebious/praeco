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

## Recheck after labelled-text citation recovery

**Observed:** 2026-10-18 UTC. The adapter still accepts provider citations only when they match retained Parse text. If a nonempty provider citation cannot be matched (including a schema-path placeholder), L1 may independently locate the extracted value in retained text under that field's recognized label. The normal verifier checks the text span, field value, label and source binding. No recovery is attempted when citations are absent, the value is not present, or no recognized label matches.

The recheck used the same synthetic USD PDF, COP PDF and PNG scan. Both PDFs matched their expected critical fields and were `READY_FOR_POLICY_EVALUATION` with `ACCEPTED` verification. The scan remained `REVIEW_REQUIRED` because OCR fidelity and several critical values could not be grounded. Provider usage was **24 credits** (3 Parse + 5 Extract per input), equivalent to **US$0.03** at the published rate.

| Input | Fields match | Praeco result | Verification | Notes |
|---|---:|---|---|---|
| Digital USD invoice | Yes | `READY_FOR_POLICY_EVALUATION` | `ACCEPTED` | Synthetic smoke only |
| COP cuenta de cobro | Yes | `READY_FOR_POLICY_EVALUATION` | `ACCEPTED` | Synthetic smoke only |
| PNG scan | No | `REVIEW_REQUIRED` | `REVIEW_REQUIRED` | `OCR_FIDELITY_UNVERIFIED`; critical fields remain ungrounded |

## Adversarial review restriction

The recovery used in that live recheck was subsequently narrowed. The current `page-scoped-citations-v1` policy recognizes only the exact schema placeholder for the extracted field and requires one complete labelled-value match on its cited, existing page. It never searches another page to repair a bad citation. Unrelated quotes, wrong-field placeholders, nonexistent pages and nonunique matches remain review signals, including when another citation supports the field.

The retained extraction artifact now contains `providerResult` and `citationAudit`. Recovery entries record the field, original cited page, reason, rule and resulting evidence IDs; rejected citations retain their reason. The provider result is preserved separately from the adapter's findings. Deterministic regressions exercise these restrictions; no live hosted recheck has been run for the narrowed policy.

## Decision

LlamaParse processed the three synthetic inputs at the cost-effective tier. An earlier adapter revision passed the two synthetic digital-PDF smoke cases using local labelled-text grounding and kept the scan in review. The current page-scoped policy has deterministic regression coverage; those earlier hosted results do not validate this revised adapter or general LlamaExtract accuracy. Do not weaken the verifier or treat confidence scores as evidence. Independent human field annotation and broader provider evaluation remain pending. For the hackathon demo, use Praeco's deterministic synthetic extractor for the labelled fixture corpus; present hosted behavior as a limited historical synthetic smoke result.

No real customer or company documents were sent. No financial decision or payment was made. Independent human annotation and broader provider quality validation remain pending.
