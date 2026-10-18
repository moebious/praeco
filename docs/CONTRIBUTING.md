# Contributing to Praeco

## Conventional Commits — mandatory

Every commit and pull-request title MUST conform to [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

Format:

```text
<type>(<scope>): <imperative summary>
```

Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`.

Recommended scopes: `repo`, `l1`, `l2`, `l3`, `demo`, `agentmail`, `daytona`, `web`, `api`, `architecture`.

Examples:

- `feat(l1): verify source digest before extraction`
- `fix(l2): fail closed on missing FX snapshot`
- `test(demo): reject previously authorized invoice`
- `docs(l3): define agent capability grants`
- `chore(repo): initialize Praeco repository`

Breaking changes must include `!` and a `BREAKING CHANGE:` footer explaining the migration. Praeco repository v1 retains the historical L1 v3.0.0 wire contract; propose contract amendments through an ADR instead of silently changing it.

## Non-negotiable design boundaries

1. **L1** owns evidence, extraction, provenance and normalization. It does not authorize payments.
2. **L2** exclusively owns policy authorization, budgets and the decision ledger.
3. **L3** owns agent collaboration, delegation, memory, approval routing and cross-source `PayableCase` correlation.
4. **DEMO-001** provisions only synthetic invoices, contracts, vendors and financial state. Its expected-decision oracle is test-only and must never reach runtime prompts or application bundles.
5. Simulated authorization is not a real payment. No banking credentials, customer data, company data, real transfers or production integrations that execute payments.
6. Approval by a human does not bypass hard policy failures; all authorizations must re-evaluate authoritative current state.
7. No credentials or secrets in this public repository. Scrub logs and examples of non-synthetic payment identifiers.

## Implementation workflow

Prefer small scoped pull requests, tests for each policy invariant, and explicit ADRs for cross-layer interface changes. Run unit, integration and golden-set tests before labeling a change ready for review. Do not present fixture integrity tests as validated end-to-end authorization safety.
