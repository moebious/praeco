# L2 — Implementation Contract and Coding-Agent Handoff

**Status:** Proposed, pending ADR-002/003 review
**Target:** `@praeco/financial-decision-kernel` TypeScript package
**Repository:** `moebious/praeco`
**Priority:** P0 for 30X Blinka challenge; synthetic-only
**Preconditions:** Read AGENTS.md, ADR-001, proposed ADR-002/003, L1 runtime handoff, the L1 wire contract and eight golden scenarios.

## Product invariant

Only deterministic L2 code backed by trusted data may authorize a **simulated** payable commitment. No agent instruction, prompt, MCP response, remote browser, LlamaExtract assertion or approval click can substitute for L2's trusted evidence, six policy gates and transactional commit. `AUTHORIZED_SIMULATED` is NEVER `PAID`.

## Scope and upstream integration

Use the accepted L1 v3.0.0 package as-is. In a trusted server context obtain `await l1.reader.loadReady(authenticatedTenantId, envelopeId)`; never accept caller-crafted verified envelopes. L3 owns PayableCase cross-source identity linking and task orchestration. L2 owns business duplicate decisions, contractual rules, vendor/account allowlist, financial policy, budget, delegated capabilities, approvals and ledger mutations.

For P0, all authoritative financial records are synthetic and SQL-backed; design a provider-independent read port so future Blinka/ERP records can be resolved through a trusted context boundary. Do not add Blinka, Link, MCP, Trigger or UI dependencies to the kernel package.

## Proposed public contracts (illustrative: refine with tests; do not modify L1)

```ts
type FinancialOutcome =
  | "AUTHORIZED_SIMULATED"
  | "BLOCKED"
  | "PENDING_HUMAN_APPROVAL";
type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";
type GateStatus = "PASS" | "FAIL" | "REVIEW_ELIGIBLE" | "NOT_EVALUABLE";
type ContractMatchMode = "EXACT" | "RECURRING_TOLERANCE" | "CEILING";
type DecimalString = string;

interface GateCheckResult {
  gate: GateId;
  status: GateStatus;
  code: string;
  explanation: string;
  evidenceRefs: readonly string[];
  authoritativeRecordRefs: readonly string[];
  facts?: Readonly<Record<string, string | number | boolean | null>>;
}

interface PayableProposal {
  payableCaseId: string;             // L3 correlation only
  envelopeIds: readonly string[];   // resolve through trusted L1 reader
  externalAccountingRef?: string;   // advisory; never authorization
  // Note: Budget ID is server-derived from tenant + period; not caller-supplied.
}
interface FinancialDecisionCommand {
  proposal: PayableProposal;
  idempotencyKey: string;
  workerId: string;                 // resolved/bound to trusted principal and grant
  agentGrantRef: string;            // capability grant reference (e.g. synthetic worker grant)
}
interface FinancialEvaluation {
  outcome: FinancialOutcome;
  explanation: string;
  gateChecks: readonly GateCheckResult[];
  financialContextDigest: string;
  policyRevisionId: string;
  grantRevisionId: string;
}
interface FinancialDecisionRecord extends FinancialEvaluation {
  decisionId: string;
  tenantId: string;
  payableId: string;
  occurredAt: string;
  commitmentId: string | null;
  approvalRequestId: string | null;
}
interface HumanApprovalCommand {
  approvalRequestId: string;
  idempotencyKey: string;
  action: "APPROVE" | "REJECT";
}
interface TrustedActorContext {
  tenantId: string;
  principalId: string;
  roles: readonly string[];
  // Provided by authenticated backend, never LLM-authored.
}
interface FinancialAuthorizationService {
  preview(command: FinancialDecisionCommand, actor: TrustedActorContext): Promise<FinancialEvaluation>;
  decideAndCommit(command: FinancialDecisionCommand, actor: TrustedActorContext): Promise<FinancialDecisionRecord>;
  resolveApproval(command: HumanApprovalCommand, actor: TrustedActorContext): Promise<FinancialDecisionRecord>;
}
```

Do not allow the model to supply `TrustedActorContext`. A `preview` must be clearly marked non-binding. The implementation must specify a canonical intent digest binding amount, original currency, L1 evidence IDs/versions, beneficiary/account fingerprint (keyed HMAC with a synthetic fixture-supplied key of ≥ 32 bytes, defined in test fixtures, never in spec text), budget, contract, policy and grant revisions. Command mapping: `decideAndCommit` requires `REQUEST_SIMULATED_AUTHORIZATION` grant action; `preview` requires `PROPOSE_PAYABLE`.

### Normative evaluation & matching rules

- **L2-1 Approval binding vs budget staleness:** An approval grant binds `budgetId` and `limitUsd` revision only. Changes to `committedUsd` during an approval wait do not invalidate the approval binding; rather, the fresh G5 re-evaluation catches the budget exhaustion and legitimately returns `BLOCKED: INSUFFICIENT_BUDGET`. Structural changes (amount, currency, vendor, destination, contract, policy, grant) trigger stale approval invalidation (`APPROVAL_STALE`).
- **L2-2 Concurrency & G2 loser handling:** Obligations are created only upon successful commit. When concurrent auto-approve decisions race on the unique constraint of `payable_obligations`, the transaction loser returns `BLOCKED: G2_DUPLICATE` (if intent digest matches) or `BLOCKED: G2_CONFLICT` (if intent digest differs), never an unhandled crash or retried insert under a new key.
- **L2-3 Multi-envelope canonical payable claim:** Multiple READY invoice envelopes with identical length-prefixed canonical key (`${tenantId.length}:${tenantId}:${canonicalTaxId.length}:${canonicalTaxId}:${invoiceNumber.length}:${invoiceNumber}`) and identical intent digest constitute one obligation: select the deterministic representative (earliest registered source) and record others as corroborating duplicates. Multiple READY envelopes with the same key but different intent digest fail closed as `BLOCKED: AMBIGUOUS_PAYABLE_CLAIM`. (For case 04, the PDF is the sole invoice envelope; supplemental chat context is non-blocking advisory context).
- **L2-4 Budget period assignment:** Derive period as the UTC month of observed `issueDate`. If `issueDate` is missing or unobserved, fall back to `dueDate` (which is guaranteed observed in L1 `DEFAULT_CRITICAL_FIELDS`) and record reason code `PERIOD_FROM_DUE_DATE`. `billingPeriod` is non-blocking corroborating context.
- **L2-5 Contract match modes:**
  - `EXACT`: under-billing fails with `UNDER_BILLING_DISALLOWED`.
  - `RECURRING_TOLERANCE`: positive variance capped by `maxPositiveVariancePct`; under-billing passes.
  - `CEILING`: amounts $\le$ ceiling pass.
- **L2-6 Vendor directory join:** Join on canonicalized tax ID (uppercase alphanumeric, no punctuation). Missing or ambiguous tax ID fails closed (`BLOCKED: VENDOR_TAX_ID_UNRESOLVED`).

## Domain / SQL model (minimum)

- `organizations` or tenant scope (tenant IDs must be enforced on all reads/writes)
- `vendors` with approved state, canonical vendor ID and authoritative payment destination identifier/fingerprint (full exact match occurs inside a trusted server)
- `contracts`, `contract_revisions` and configured tolerances / validity
- `budget_periods`: tenant+UTC month, USD limit, USD committed, revision
- `policy_revisions` and `capability_grants` with scope, effective/expiry and revocation
- `payable_obligations`: canonical key, source envelope references, intent digest, status/history
- `financial_decisions`: immutable evaluation snapshot, six gate checks and cause/version references
- `approval_requests`: identity-bound request intent, expiry, lifecycle, approver actions
- `commitments` and `ledger_events`: append-only spending effects, unique payable commitment
- `idempotency_records`: tenant/actor/action/key, payload digest and final response reference

Names may vary, but preserve foreign keys, tenant isolation, unique constraints, and consistency between commitment and budget update. SQL migrations and rollback/reseed steps are required. Never treat Prisma/Drizzle ORM transactions alone as proof of no overspend: prove with concurrent integration tests.

## Build order / vertical slices

**Slice A — Pure kernel:** schema and types; exact decimal gate evaluators; independent decision explanation; fixed FX from accepted L1; unit tests per gate including G6 vs hard-fail precedence. Do not implement fake payment success.

**Slice B — Trusted SQL context:** synthetic data seeding for eight *isolated* scenarios; vendor, contract, policy/grant and budget resolvers; scope/version validation; synthetic `FinancialContextResolver` port.

**Slice C — Atomic authorize:** decide-and-commit transaction with payable unique key, row protection/conditional budget updates, idempotent command record, append-only ledger and tests for retries plus parallel spending. No demo UI until this is correct.

**Slice D — Human approvals:** authenticated FinanceAdmin, 24h expiry, no pending hold, single-use bound approval, fresh full six-gate evaluation and current-budget commit; rejection/revocation/races. A late APPROVE whose fresh re-evaluation hard-fails, or whose authoritative commit is blocked by a concurrent claim or budget exhaustion, closes the request in the terminal lifecycle state `APPROVAL_BLOCKED` (a lifecycle state, not a fourth verdict): the immutable resolution decision is `BLOCKED`, an idempotency receipt is written so the same key replays the same decision, and any other key fails closed with `APPROVAL_ALREADY_RESOLVED`. A blocked approval is never retryable through a second human action.

**Slice E — Integration and audit:** trusted `reader.loadReady()`; deterministic gate trace and historical replay; output models consumable by L3/UI without secrets; integration tests for all eight fixtures.

Do not modify the L1 v3.0.0 contract, accepted ADR-001, or golden expectations to make a failing test pass.

## Golden oracle (test-only, never accessible to runtime/LLM)

All cases run under synthetic worker grant seed: `perPayableLimitUsd: "2500.00"`, `allowedActions: ["PROPOSE_PAYABLE", "REQUEST_SIMULATED_AUTHORIZATION"]`.

| Case | Expected financial verdict | Key gate | Seed Context & Worker Grant |
| --- | --- | --- | --- |
| 01 Bogotá contractor USD 2,200 | AUTHORIZED_SIMULATED | eligible | Grant limit $2,500; budget $5,000; contract exact $2,200 |
| 02 SaaS USD 480 vs authorized recurring USD 470 (+2.13%, max 5%) | AUTHORIZED_SIMULATED | contract tolerance | Grant limit $2,500; recurring tolerance mode (max +5%) |
| 03 Mexico MXN 76,000 / 20 = USD 3,800 | PENDING_HUMAN_APPROVAL | G6 USD 2,500 autonomous threshold | Grant limit $2,500 (< $3,800); contract ceiling $4,000; budget $4,500 |
| 04 Argentina USD 1,950 PDF; chat +450 vs authorized USD 1,500 | BLOCKED | unapproved amendment | Grant limit $2,500; contract exact $1,500 |
| 05 Forwarded changed-hash invoice duplicate of #01 | BLOCKED | payable business identity | Grant limit $2,500; preseeded commitment for Case 01 |
| 06 COP 2,400,000 / 4,000 = USD 600 unknown vendor | BLOCKED | nonallowlisted | Grant limit $2,500; tax ID not allowlisted in trusted vendor directory |
| 07 USD 2,100 vs USD 1,400 budget | BLOCKED | funds insufficient | Grant limit $2,500; available period budget $1,400 (< $2,100) |
| 08 USD 1,200 changed bank account | BLOCKED | destination mismatch | Grant limit $2,500; payment account differs from trusted vendor directory |

Each case has **independent seed state**. Do not run them against one shared ledger unless explicitly in a separate sequential suite. Never import `ground-truth` files into runtime code.

## Acceptance gates

- Exactly the canonical eight outcomes, each with legible checks and evidence/source references.
- An over-limit invoice with simultaneous invalid vendor/contract/budget returns BLOCKED (not PENDING).
- Exact decimal comparison at `MXN 50000.01 / 20` is GREATER THAN USD `2500`, despite rounded display.
- Duplicated invoice bytes, changed-hash forwards and conflicting invoice keys cannot double-commit.
- Concurrent financial decisions compete safely for one budget; at most one USD 700 may spend USD 1,000 available.
- Auto-approve concurrency race loser on unique constraint returns `BLOCKED: G2_DUPLICATE` (if intent digest matches) or `BLOCKED: G2_CONFLICT` (if intent digest differs).
- Identical command retry returns **the same record**, different payload with same key is rejected.
- Worker grant scope enforced: worker without `REQUEST_SIMULATED_AUTHORIZATION` cannot commit; worker with `perPayableLimitUsd: "2000.00"` cannot auto-approve USD 2,200.
- Contract match mode enforced: under-billing on `EXACT` mode fails with `UNDER_BILLING_DISALLOWED`; under-billing on `RECURRING_TOLERANCE` passes.
- Approved G6 exception passes only if current hard gates and intent binding still pass. Revoked/stale/expired approval fails and cannot debit.
- A new budget spend during an approval wait causes a legitimate `BLOCKED: INSUFFICIENT_BUDGET` on fresh G5 evaluation without invalidating approval binding.
- Replay with original versions reproduces the recorded gate outcome without writing; current reevaluation is explicitly separate.
- Unauthorized tenant/actor access and model-provided financial context are rejected.
- Redacted UI payloads contain no complete banking account identifiers.
- `npm run check` passes, plus PostgreSQL-backed integration test report (using disposable Neon branch, provisioned local Postgres, or Docker). No claim about a successful bank payment.

## Delivery

Create `packages/financial-decision-kernel/`, migrations, synthetic finance seed fixtures and tests; add integration docs for L3. Implement with narrow PRs and Conventional Commits (`feat(l2): ...`). Keep architecture docs and implementation states honest. Do not migrate to Pi Durable, instantiate virtual machines, introduce a general MCP server or connect real payment rails as part of L2.

**Known open integration detail:** L3's multi-source PayableCase resolver and financing administrative UI are not yet built; use an explicit trusted synthetic case adapter in tests, never have L2 infer contract amendments from chat. If a required business decision is unspecified, fail closed and record the precise blocker instead of creating an implicit allow rule.
