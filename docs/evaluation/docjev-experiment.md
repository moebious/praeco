# L1 — DocJev decision-engine experiment (OpenRouter)

**Status:** Proposed / NOT executed. Documentation and a manual GitHub Actions workflow only. No real financial documents and no change to the canonical L1 contract.

## Hypothesis

DocJev can classify or split synthetic AP document packets. Its **Jev** decision engine is not a field extractor, an independent human annotator or a substitute for L1 verification. The current experiment **classifies exactly two synthetic PDF invoices**, one request each; it does not yet test splitting. Boundary classification and field-level precision/recall need separate fixtures, labels and measurement logic.

## Run modes

Manual workflow: `.github/workflows/l1-docjev-evaluation.yml`.

- **preflight** (default): process two synthetic PDFs with local LiteParse; zero Jev calls, no OpenRouter key injected.
- **live** (explicit manual input): at most two sequential DocJev classify calls using Jev 1.14 and `TYPESAFE_API_KEY` supplied from the private repository secret `OPENROUTER_API_KEY`. No retries in our runner; upstream SDK may have its own retries (DocJev defaults to one), so this is *not* a guaranteed two-request billing cap.
- Each execution uses only `01.pdf` and `02.pdf` from the synthetic corpus. The reporter emits categories/flags only, not document bodies or the secret. Outputs are printed in CI and are **not proof of independent ground truth**.
- Pin the upstream DocJev Git commit to `c7abe276a970605feb9cb8b27513365b6c10726e`. Review dependency versions before production reproducibility claims.
- The expected category (`invoice`) is only a provisional synthetic assertion; review document annotations independently before publication.

## Secrets and governance

The repo secret `OPENROUTER_API_KEY` should be set via GitHub Actions Secrets and never pasted into chat. Set up the repository Environment named `evaluation` with an approval reviewer before enabling live runs. GitHub Actions workflows invoked through `workflow_dispatch` on default branch may require merging the workflow first; alternatively, run the same script from a controlled branch/checkout after review. **Do not merge this Draft PR merely to trigger billable inference without review.**

`TYPESAFE_BASE_URL=https://openrouter.ai/api` and `TYPESAFE_API_KEY` target the TypeSafe protocol through OpenRouter, not the OpenAI Chat Completions endpoint. Compatibility and model identity must be confirmed empirically; no authenticated request was made during PR authoring.

## Failure behavior and limitations

Provider errors fail the job without emitting source excerpts, but upstream SDK and CI process behavior still require a credential-leak audit. The runtime code in `packages/evidence-intelligence` is unchanged. No extracted financial fields, L2 decisions, bank payments or acceptance upgrades are made on a Jev classification result.

**Next experiment:** curated multi-invoice synthetic packet with page-level expected boundaries, classification/splitting confusion matrix and explicit review of uncertainty. **Separate field-evaluation PR:** annotate invoice number, dates, beneficiary, account and amounts directly from retained source documents, then measure field-specific precision/recall and unsafe READY rate. Human review/sign-off remains required to claim independent annotation.
