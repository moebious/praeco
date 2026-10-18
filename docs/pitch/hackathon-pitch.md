# Praeco — Three-minute hackathon pitch

Working draft · 2026-10-18 · Audience: 30X Hackathon / Blinka judges

## Core message

**Praeco is an AI finance team that works within delegated authority, with source-backed evidence and enforced financial rules.**

Accounts payable is the first use case. The intended user is the finance operator responsible for checking invoices, resolving exceptions and explaining decisions. The value hypothesis is less manual case preparation, with human attention focused on eligible exceptions. Time savings and customer demand still need validation.

## Spoken script and stage cues

Approximately 330 spoken words plus a 35-second demo. Rehearse to the clock; the time boxes are targets.

### 0:00–0:25 · The problem

An invoice arrives. The vendor is familiar. The amount looks right. But the bank account has changed.

Before acting, someone has to check the invoice against the vendor record, the contract, the budget and previous invoices. Those checks are the work behind accounts payable—and an AI assistant needs enforceable limits before we can delegate that work.

### 0:25–0:50 · The product

Praeco is an AI finance team built to work within those limits.

Our product brings together three specialist roles: Vera prepares the evidence, Kael explains policy checks, and Nova works within delegated financial authority. The goal is to give a finance operator a prepared case, a traceable decision and a clear next action.

### 0:50–1:20 · How authority works

We separate understanding documents from authorizing a financial action.

The evidence layer extracts facts and links them to their sources. A deterministic decision kernel checks evidence integrity, duplicates, the beneficiary and account, the contract, available budget and the automatic authorization threshold.

Agents submit proposals. The kernel controls the decision. Missing or conflicting critical evidence blocks authorization. An otherwise eligible invoice above the delegated limit goes to human review. Human approval still requires every hard gate to pass.

### 1:20–1:55 · Demonstration

All examples are synthetic, and no real money moves.

**[Show a valid invoice → `AUTHORIZED_SIMULATED`.]**

This invoice passes the required checks.

**[Show the changed-account case → `BLOCKED`, with the destination mismatch.]**

This familiar vendor has a different destination account. Praeco blocks it.

**[Show an eligible invoice above the limit → `PENDING_HUMAN_APPROVAL`.]**

This case needs an authorized human decision.

### 1:55–2:30 · What exists today

We have implemented the local evidence pipeline, the six-gate decision kernel and the human approval lifecycle. The financial components can be demonstrated through the CLI; connecting them to the new conversational workspace is our next integration milestone.

The hackathon runtime uses in-memory state. Persistent storage and production integrations remain future work.

### 2:30–3:00 · Close

We are starting with accounts payable because every invoice brings together evidence, authority and accountability.

Our next proof point is one complete workflow: from source documents, through agent preparation and policy checks, to a decision the operator can inspect.

Praeco's ambition is autonomous financial operations with explicit authority and a record of why each action was allowed, blocked or escalated.

## Visual plan

| Beat | On screen |
| --- | --- |
| Problem | One synthetic invoice; highlight “bank account changed.” |
| Product | Vera → evidence · Kael → policy · Nova → delegated authority. Label a product mockup as such. |
| Authority | Sources → evidence → deterministic gates → decision; human review for eligible exceptions. |
| Demo | Three financial decision records, with the exact outcome labels visible. |
| Close | “Autonomous financial operations. Explicit authority. Traceable decisions.” |

Use the current CLI financial demo for the proof segment. A workspace preview can illustrate the product direction, but its programmed conversations do not demonstrate live financial integration. Keep the three examples ready in a single view or recording to avoid spending the demo navigating terminals.

## Demo preparation before presenting

- Run `npm run check`, then rehearse `npm run l2:demo` and verify the three selected outputs against the spoken script. This pitch draft does not record a fresh test run.
- Rehearse the full pitch with those outputs visible. If live switching exceeds 35 seconds, use a clearly identified recording of the actual run.
- Display `AUTHORIZED_SIMULATED` explicitly and retain the synthetic-data / no-real-payments label.
- Keep the eight canonical scenarios as backup material. The expected distribution is an acceptance target: two simulated authorizations, one human escalation and five blocks. Do not present that distribution as a newly verified end-to-end result.

## Likely judge questions

**Why use agents?** To coordinate document preparation, missing-context follow-up and explanations across sources. Deterministic rules retain financial authority.

**What if the model invents a fact or an invoice contains instructions?** Model text is not financial authority. The design requires trusted source evidence and policy evaluation; untrusted document content cannot grant permissions. Demonstrating resistance across the integrated workflow remains part of acceptance work.

**Can a human approve a changed bank account anyway?** Human consent cannot bypass a failed hard gate. The underlying trusted records and evidence would need to satisfy policy before a new evaluation could authorize it.

**Is this ready to handle real payments?** The current system is a synthetic hackathon prototype with simulated authorization. Production persistence, integrated workflow validation and any payment rails require further work.

**Who would buy it, and what does it save?** Our initial customer hypothesis is a finance team with recurring vendor invoices and manual exception handling. Pilot interviews and measured review time per case are the next commercial validation steps; we have no validated ROI or traction claim yet.

## Internal sources for claims

- [Current repository status and demo commands](../../README.md)
- [Authority and implementation boundaries](../../AGENTS.md)
- [Process-local demo runtime](../adr/007-in-process-demo-runtime.md)
- [Canonical scenarios and acceptance requirements](../evaluation/golden-scenarios.md)
- [Workspace status and limitations](../../apps/finance-workspace/README.md)

This draft uses repository evidence only. It makes no external market-size, competitor, customer, extraction-accuracy or savings claims.
