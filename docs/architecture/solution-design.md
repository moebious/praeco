# Praeco — Solution Architecture: Governed Financial AI Teammates

**Status:** Historical design reference; L3 ownership/runtime and L2 financial defaults superseded by ADR-002–006 and the L3 implementation contract. Not an accepted ADR.
**Date:** 2026-10-17
**Product:** Praeco — 30X Hackathon / Blinka Accounts Payable challenge
**Source of product direction:** Founder design vision for AI Teammates + delegated Agent Wallets
**Current normative proposals:** [ADR-004](../adr/004-domain-specific-agent-harness.md), [ADR-005](../adr/005-durable-assignment-execution.md), [ADR-006](../adr/006-multichannel-identity-and-messaging.md), [L3 implementation contract](l3-implementation-contract.md). **Authoritative financial baseline:** [ADR-002](../adr/002-deterministic-financial-authorization.md) and [ADR-003](../adr/003-governed-wallets-transactional-ledger.md). Original reference: [ADR-001](../adr/001-evidence-boundaries.md).

> **Architecture reconciliation (2026-10-17):** The diagrams below illustrate the initial AI-teammates concept, not the final L3 implementation dependency graph. P0 uses **Trigger.dev (exclusive Assignment workflow owner) + Vercel AI SDK (bounded tools/model) + Chat SDK/direct adapters (channel transport)**. Eve/Pi Durable are deferred alternatives. A single Praeco tenant-bound agent identity uses Vera/Kael/Nova as capability profiles by default. ADR-003 resolves pending holds: **none in P0**. ADR-002/003 resolve financial policy and budget gates. Do not implement stale open choices or the older Trigger/AI roles as conflicting authorities. See the L3 implementation contract for the current normative proposal.

## 1. Product thesis

Praeco is a **domain-specific team of governed finance agents**. People collaborate with specialist AI teammates through direct and group chats; documents are transformed into source-linked facts; financial obligations are evaluated by a deterministic kernel; and simulated commitments operate only within explicitly delegated authority.

The company operating experience is inspired by [Code With Antonio / AI Teammates](https://github.com/code-with-antonio/ai-teammates) and its [Figma design reference](https://www.figma.com/community/file/1687626424545823126/ai-teammates-tutorial-design-reference). The external design and code are **references**, not permission to copy without checking their licenses and asset terms.

**No real money moves.** A passing decision is AUTHORIZED_SIMULATED, never PAID. This is a synthetic hackathon system, not an asserted production-grade bank integration.

## 2. Experience and roles

**Workspace:** left sidebar with 1:1 agent conversations and finance-committee group rooms; central streaming transcript, document uploads, handoffs and tool activity; right **Agent Wallet & Audit Inspector** with budget, policy, evidence, decision gates and approval actions. A **Desktop** tab may later show a Daytona/noVNC sandbox with human takeover; it does not replace the financial inspector.

- **Vera — AP Evidence Analyst:** receives documents, invokes trusted L1 processing, reports source references and uncertainty.
- **Kael — Policy Auditor:** submits proposals for L2 evaluation, requests rechecks, explains gate outcomes from decision records.
- **Nova — Wallet Controller:** presents delegated spend scope and authoritative balances, requests L2 simulated authorization or human approval.
- **Finance human (CFO/approver):** approves policy changes and eligible exceptions through authenticated, bounded actions; cannot override hard gate failures.

A conversational **handoff** changes which assistant is responding. A durable **Assignment** is an independently tracked unit of work with identity, capabilities, run history and outcome. They are not interchangeable. No role/personality can grant itself financial permissions.

## 3. System context and ownership

~~~mermaid
flowchart TD
    U["Finance operator / CFO"]
    UI["Next.js Finance Workspace<br/>Chat + Wallet & Audit Inspector"]
    C["Clerk Auth<br/>Identity and sessions"]
    TR["Trigger.dev<br/>Durable execution / waits / retries"]
    H["L3 — Praeco Agent Harness<br/>Assignments + capability checks"]
    AG["Vera · Kael · Nova<br/>AI SDK agent loops"]
    L1["L1 — Evidence Intelligence<br/>Immutable source + verification"]
    OBJ[("Original artifacts<br/>restricted object storage")]
    K["L2 — Deterministic Financial Kernel<br/>Six gates + decide-and-commit"]
    DB[("Neon PostgreSQL (candidate)<br/>authoritative policy + financial ledger")]
    HITL["Authenticated human review"]
    SB["Daytona sandbox / VNC<br/>optional computer use"]
    OBS["Sentry / telemetry<br/>not financial authority"]

    U <--> UI
    C --> UI
    UI <--> TR
    TR --> H
    H --> AG
    AG --> L1
    L1 <--> OBJ
    AG -. "Optional tools" .-> SB
    H -->|"Server-side proposal"| K
    L1 -->|"Trusted evidence references"| K
    K <-->|"Atomic policy + budget state"| DB
    K -->|"Eligible escalation"| HITL
    HITL -->|"Identity + scoped consent"| TR
    TR -->|"Reevaluate via L2"| K
    K -->|"Decision record"| UI
    TR -.-> OBS
    H -.-> OBS
    K -.-> OBS
~~~

**Ownership rule:** Trigger.dev owns durable task execution, L3 owns work/permissions/delegation, L1 owns evidence transformations, **L2 alone** owns financial eligibility and budget effects, and PostgreSQL is the proposed authoritative storage for those effects.

## 4. End-to-end flow

~~~mermaid
sequenceDiagram
    actor CFO as Operator / CFO
    participant UI as Finance Workspace
    participant T as Trigger.dev + L3
    participant E as L1 Evidence Intelligence
    participant K as L2 Decision Kernel
    participant D as Financial Ledger

    CFO->>UI: Upload invoice / request AP close
    UI->>T: Start case + assignment
    T->>E: Process immutable source
    E-->>T: Verified envelope + source references
    T->>K: Propose payable action (scoped)
    K->>D: Load current authoritative state
    K->>K: Evaluate all six gates
    alt hard failure
        K-->>T: BLOCKED + check results
    else eligible above autonomous threshold
        K-->>T: PENDING_HUMAN_APPROVAL
        T-->>CFO: Request authenticated, scoped consent
        CFO->>T: Approve or reject
        T->>K: Resolve and reevaluate all gates
        K->>D: Atomic decision and optional commitment
        K-->>T: Final outcome
    else all gates pass
        K->>D: Atomic idempotent decision + commitment
        K-->>T: AUTHORIZED_SIMULATED
    end
    T-->>UI: Explain decision and show wallet/audit state
~~~

Per ADR-003, **pending approval does not reserve budget in P0**; a workflow wait is not a financial hold. L2 must not treat an earlier preview or human click as a substitute for a current transactionally valid decision.

## 5. Data and domain separations

| Layer | Owns | Must not own |
| --- | --- | --- |
| **L1 — Financial Evidence Intelligence (accepted interface)** | DocumentSource, immutable artifact references, ObservedField, VerificationReport, InvoiceEnvelope, financial normalization | Vendor allowlists, payable duplicate resolution, financial approvals |
| **L2 — Financial Decision Kernel (proposed)** | Vendor master, trusted accounts/contracts, PolicyBundle, BudgetPool, WalletAllocation, PaymentObligation, DecisionRecord, ledger and approvals | OCR, speculative contract matching via LLM, chat persona |
| **L3 — Praeco Harness (proposed)** | Worker, Assignment, PayableCase, capability-constrained tools, conversations, execution events, case lifecycle | Independent finance verdicts or direct ledger mutations |
| **External service adapters** | Parser, classifier, model provider, object storage, sandbox and observability integration | Domain authority |

Document parsing is **adaptive**: direct native email/chat text, LiteParse for suitable PDFs, LlamaParse candidate for difficult inputs, optional DocJev for mixed packet classification/splitting, and structured extraction/independent verification before L2. DocJev does **not** certify financial fields or detect payable fraud. Generic RAG/LlamaIndex/pgvector is **optional advisory retrieval**, not mandatory for L1 or L2.

Operational agent memory and search indexes may suggest relevant context; only the trusted vendor, contract, policy and budget records determine financial validity. In the future the workspace might be reused for a Company Brain or Personal Assistant, but **cross-product memory, data and authority must not be shared by default**.

## 6. Infrastructure candidates, not frozen dependencies

| Concern | Direction | State |
| --- | --- | --- |
| UI | Next.js 16 / React 19 / TypeScript, shadcn/ui Nova (Base UI), AI Elements, resizable panels and DiceBear | Preferred UI reference |
| Chat / models | Vercel AI SDK for bounded model/tool loops; Vercel Chat SDK / native adapters for channel transport | P0 design decision; adapter versions require proof |
| Durable execution | Trigger.dev; exclusive owner of P0 financial Assignment workflows | P0 design decision in ADR-005 |
| Data | Neon PostgreSQL + Drizzle for financial transactions and operational records | Preferred |
| Human identity | Clerk Auth (distinct from financial approvals) | Preferred |
| Sandboxed work | Daytona with optional noVNC; only for jobs that need a cloud computer | Optional |
| Monitoring | Sentry with redaction/correlation; Langfuse later for model evaluation | Candidate |
| Document intelligence | Existing L1 adapters for LiteParse, LlamaParse, LlamaExtract and optional DocJev | L1 contracts accepted; runtime work separate |
| Semantic retrieval | LlamaIndex/pgvector/hybrid retrieval | Deferred |
| SaaS monetization | Clerk Billing and AI/sandbox usage limits | Deferred; **not** financial wallet accounting |
| Web research | Firecrawl | Deferred; not financial evidence by default |
| Hosting | Next.js host and distinct Trigger workers | Not selected |

The Antonio repository's AI usage ledger meters model tokens and sandbox time; it is **not reusable as the financial ledger without redesign**. Its group handoff changes current responding agent, not an independent durable assignment system. Copying its schema and calling a billing progress bar a wallet does not satisfy L2.

## 7. Reliability, trust and audit

- Enforce server-side tenant scope, human identity, capability grants and wallet/financial controls at every action boundary.
- No direct SQL writes to policies, wallets, ledgers or vendor account master from LLM tool or Daytona sandbox.
- Retain original source hashes, trusted L1 reports, policy versions, gate checks, ledger references and approval identity.
- Make simulation explicit in labels and events. Never fabricate payout receipts or settlement.
- Trigger retries and concurrent runs may repeat requests: L2 owns idempotency and budget serialization.
- Human approval is consent for an **eligible** decision; all hard gates and current budget are reevaluated afterward.
- Sentry/session replay and transcripts must not expose bank account identifiers or complete confidential invoice content. Observability is not accounting evidence.
- Preserve expected test outcomes in test-only fixtures, never prompts or application runtime.

## 8. Golden Path and scope

**P0 (must work):** ingest evidence using L1, correlate a payable case, show a committee chat and inspector, evaluate six rules via L2, atomically commit simulated authorizations, block hard violations and support one bounded HITL flow. The **eight synthetic scenarios** in [golden-scenarios](../evaluation/golden-scenarios.md) remain the canonical evaluation target: 2 authorized simulated, 1 pending human review and 5 blocked.

**P1:** multi-document splitting on a mixed synthetic packet, Sentry correlation, Daytona sandbox/desktop tab, richer natural-language explanation, richer approval review.

**P2 / future:** Company Brain, persistent knowledge retrieval via pgvector/LlamaIndex, Firecrawl, SaaS Billing, payments and additional financial rails (subject to a separate security/product design).

**Separate storyboard, not a replacement golden set:** a USD 7,500 monthly simulated wallet, USD 2,720 in initial commitments and a USD 3,400 human-reviewed obligation illustrate the UX. Its vendor names and values do not override accepted demo fixtures.

## 9. Open decisions and review checklist

1. **Resolved by ADR-002/003:** USD corporate period budget, no pending holds, FinanceAdmin consent, payable identity, configured tolerance and SQL transaction protection.
2. **Do not reopen during L3 implementation:** financial authorization semantics remain solely in L2.
3. Define exact L1-to-L3 case correlation and trusted L1-to-L2 reader.
4. Confirm platform credentials, data isolation, migrations, cost/limits and demo deployment.
5. Validate reference repo/design licensing before copying substantial files or artwork.
6. Obtain tests that prove financial concurrency, replay, idempotency and fail-closed behavior; no claims of production readiness before those results.

**Change control:** L1's existing accepted contracts remain unchanged. Approve L2/L3 design only through explicit ADRs after resolving open questions. This document is not authority to implement unresolved business rules by assumption.
