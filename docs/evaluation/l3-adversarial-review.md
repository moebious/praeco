# PR #5 — Adversarial architecture review

**Reviewed head:** `52900d7bea7c0495dfa85c8143191899667304d7`.
**Fixed base:** `fa9512d3974d536438b51563996193762b0b0afe` (merged PR #4).
**Scope:** documentation and illustrative contracts; no L3 runtime or real payment integration.

PR #5 merged at the reviewed head before these amendments were published. The corrections are delivered as a follow-up to that merged baseline; later main-branch changes concern L1 experiments and do not alter the reviewed L3 files.

The specification is the PR description, ADR-004–006 and the implementation contract, checked against the existing L1 runtime, ADR-001–003, L2 contract and eight financial scenarios. The user explicitly selected a simpler L3 without Eve or a second orchestration layer. The Spec axis received a separate read-only agent review. The parallel Standards agent could not run because of a usage limit; the primary reviewer performed that axis directly.

## Standards

- **P1 — Protected mutation omits trusted caller scope.** Original `l3-implementation-contract.md:120` defined `advance()` using only Assignment ID, expected version, next state and output references. `AGENTS.md` requires typed ports, tenant isolation and separation of actor/capability authority; ADR-004 requires server-resolved identity. Knowing another Assignment's ID/version must not permit a transition. **Resolved:** protected ports take authenticated backend context, with current tenant/resource authorization plus active run/ownership epoch and version guards. Model-facing JSON cannot supply principal, roles, worker grants or ownership metadata. Financial intent and idempotency survive replacement attempts.
- **P2 — Operational lifecycle contradicts its declared type.** ADR-005:23 listed operational `BLOCKED`, while `AssignmentState` excluded it and L2 exclusively owns the financial verdict. This conflicts with the repository's explicit separation of workflow and financial decisions. **Resolved:** remove operational BLOCKED; an L2 block completes the Assignment with the real decision reference. Cancellation cannot hide unresolved or committed finance effects. Glossary definitions distinguish Assignment, role/principal and approval lifecycle.

No code-smell heuristic was promoted to a blocking finding; this is a documentation PR, and no SDK/runtime abstraction was added.

## Spec

- **P1 — Approval recovery cannot locate the resolution decision.** Original `l3-implementation-contract.md:155–156` required reading the “current L2 decision status,” but exposed only `getDecision`. L2 decisions are immutable snapshots and approval performs a fresh evaluation. Lost wake-up delivery would reread the original PENDING forever. **Resolved:** a protected approval lifecycle query returns the resolution decision ID; resume verifies request/tenant/intent bindings and preserves both original and resolution references. Read before/after wait registration and on bounded wake/timeout/reconciliation. Wait output never constitutes consent. L2 read-side adapters remain a required integration dependency, not an implemented API claim.
- **P2 — Evidence interface discards supplemental processing identity.** Original `l3-implementation-contract.md:123–126` returned only envelope IDs, conflicting with ADR-005's recovery of stored run/artifact references. Valid supplemental input becomes `[]`. **Resolved:** retain source/hash/run/disposition and optional external binding; expose trusted run recovery. Context-only work never creates an invoice or financial intent; uncertain invoice results require a nonempty envelope list.
- **P2 — Installation scope differs across identity/deduplication.** ADR-006:20 omitted installation in principal/message bindings; ADR-005:28 omitted it from inbound deduplication while the implementation contract included it. Two installations with equal local event/user/thread IDs could suppress unrelated work or resolve the wrong principal. **Resolved:** consistent tenant/provider/installation scope for bindings, receipts, conversations, transport state and recipient lookup; backend payload digests detect conflicting event-key reuse.

**Original findings:** Standards 2 (worst P1); Spec 3 (worst P1). All five have explicit contract resolutions; none is claimed fixed by an implemented L3 runtime. A read-only re-review of the revised Spec found no remaining concrete P1/P2 blocker to this documentation baseline.

## Additional design checks

- Trigger is the sole durable Assignment executor. SQL holds canonical operational state and guards; outbox/reconciliation only delivers commands to that owner. Eve/Pi Durable are excluded from the baseline and scheduled roadmap.
- Trigger deduplication expiry, failed-run recreation or stale workers cannot create a new financial intent/key. An uncertain L2 call is reconciled through authoritative command receipts.
- Notification delivery is best effort. Every send rechecks recipient/installation/read permission; missing provider send idempotency can duplicate a redacted notification, never a financial commit. Delayed versions cannot reopen approval work.
- L1 wire contracts, L2 policy/ledger contracts and expected financial outcomes are unchanged. Real L3 financial slices remain blocked on the actual L2 service and protected command/approval read side. Fakes remain test/storyboard-only.
- Vendor behavior was checked against the official references linked in the implementation contract. Exact SDK versions and real webhook/transport behavior still require a vertical POC; no accounts, credentials or runtime dependencies were provisioned here.

## Acceptance walkthroughs and implementation gate

| Scenario | Required path after review |
| --- | --- |
| Approval commits; wake notification is lost | Lookup by approval request ID, load new immutable resolution decision, preserve original PENDING |
| Approval resolves before wait registration / token times out early | Check lifecycle before/after registration and on wake; continue bounded reconciliation |
| Two installations share event/user/thread IDs | Separate scoped binding/receipt/conversation records; no cross-delivery |
| Same event key carries altered actionable payload | Reject normalized digest mismatch; no extra Assignment or financial intent |
| Worker knows a foreign ID/version or has stale ownership | Current authorization and tenant/run/epoch/version guards reject the operation |
| Supplemental intake returns no envelopes, then process restarts | Recover source/hash/run/disposition; no fabricated invoice or blind new run |
| Trigger key expires / a failed run is recreated | SQL intent/key remains stable; reconcile the same L2 command |
| Cancellation races an unresolved finance command/approval | Retain cancellation request and reconcile; never conceal or reverse an existing commitment |
| Recipient access is revoked after outbox enqueue | Recheck on send; private output is suppressed |
| Channel accepts a send but acknowledgment is lost | Delivery uncertainty/duplicate redacted output is possible; L2 is not rerun |

These are architectural walkthroughs and mandatory future test cases, **not executed L3 adversarial tests**. Implementation must prove them with database concurrency, fake channels and protected L2 adapters before claiming a working financial harness. Existing repository tests protect L1 compatibility; they do not establish L3 or end-to-end financial safety.

## Validation record

- `npm run check`: passed typechecks, 136 tests (111 evidence-intelligence + 25 external-document-intake) and both workspace builds at the reviewed baseline. These are compatibility checks, not L3 runtime tests.
- The illustrative TypeScript contract compiles in strict mode against the existing L1 package. Five negative type probes reject missing mutation context, missing decision-read principal, envelopes on supplemental context, empty invoice results and operational `BLOCKED`.
- All 13 relative links across the eight changed Markdown files resolve; `git diff --check` passes.
- Frozen L1 packages/contracts, L2 ADRs/contracts, golden outcomes and dependencies are unchanged by the amendments.
- Follow-up CI must pass on the published head before merge. Runtime L3 behavior remains unimplemented regardless of those results.
