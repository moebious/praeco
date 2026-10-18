# Governed Agent Wallets — Conceptual Model

**Status:** Proposed / Under Review (not an accepted ADR or implemented payment product)
**Date:** 2026-10-17
**Scope:** Praeco synthetic Accounts Payable demonstration
**Related:** [L2 kernel](financial-decision-kernel.md) · [Solution design](solution-design.md)

> **Definition:** An Agent Wallet is a **view of delegated, policy-governed authority over a company's simulated budget**, associated with an agent identity. It is not a bank account, private key, crypto wallet or independently funded account.

## 1. Why this abstraction exists

An AI teammate may prepare an obligation and request a financial action; an authorized business actor may delegate narrowly limited autonomy. An Agent Wallet makes that delegation legible: **who** may propose what action, **against which enterprise budget**, **for which vendors/categories**, **under which policy version**, **up to what limit** and **until when**. The deterministic L2 kernel enforces these restrictions even when the agent is compromised or confused.

For this hackathon **no real funds move**. Even after a simulated authorization, the UI must say **AUTHORIZED_SIMULATED**, not PAID, AUTO_PAID or transfer completed. Distinguish a recorded simulated commitment from an external payout.

## 2. Authority graph and conceptual objects

| Object | Owner | Meaning |
| --- | --- | --- |
| Corporate Budget Pool | Finance administrator / L2 | Shared simulated amount for a tenant, currency and accounting period |
| Wallet Allocation or Spending Scope | L2 | Agent-visible permitted portion/scope of corporate budget; does **not** mint or duplicate funds |
| Worker / Agent Identity | L3 | Vera, Kael or Nova, with auditable actor identity; persona alone confers no permission |
| Capability Grant | Trusted administration + L2 enforcement | Approved actions, resource scopes, ceilings, categories, vendors, effective interval and revocation |
| Policy Bundle | Finance administrator, evaluated by L2 | Versioned rules that constrain every decision |
| Payment Obligation | L2 | Business liability, distinct from uploaded source file and chat message |
| Budget Reservation | L2 | Optional temporary hold affecting availability, if the pending-hold design is accepted |
| Simulated Commitment | L2 | Authorized budget effect; no money transfer |
| Ledger Event | L2 | Append-only accounting event with actor, cause, version and idempotency identity |
| Approval Request | L2/HITL | Scoped request for human consent; not itself a bypass of hard gates |
| Wallet Inspector | UI | Read-only representation of authoritative state and provenance |

At minimum each protected financial action identifies tenant, actor, capability, payable obligation, target budget, amount/currency, relevant policy version and stable idempotency key. Tenant boundaries and trusted user identity must be enforced server-side.

## 3. Budget arithmetic (proposed invariant)

**Available = Allocated − Committed − Active Reservations.**

Allocation is not new money. If multiple wallets can draw from the same enterprise budget, L2 must enforce both the wallet's delegated limit **and** the shared budget's remaining capacity. The sum of wallet displays must not be mistaken for extra corporate liquidity. Reservation expiry, use, release, correction and rollover require explicit ledger semantics.

For a demo view, **USD 7,500 initial budget** followed by two simulated commitments totaling **USD 2,720** leaves **USD 4,780** before other holds. A subsequent **USD 3,400** human-approved commitment leaves **USD 1,380**, assuming no competing reservations or policy changes. **These are storyboard figures, not golden fixture values**; the published eight-scenario Golden Set remains authoritative for evaluation.

## 4. How each teammate interacts with the wallet

| Role | Can request | Cannot do |
| --- | --- | --- |
| Vera — Evidence Analyst | L1 document processing and source attribution | Create policy, approve commitments, edit accounts |
| Kael — Policy Auditor | Preview/replay of L2 checks and auditable explanation | Independently pronounce a binding PASS or mutate policy |
| Nova — Wallet Controller | Ask L2 to decide and commit; present balances and request eligible approval | Sign actual payments, issue funds, edit authoritative ledger |
| CFO / Authorized Human | Activate policy revisions and decide **eligible** approval requests | Override hard evidence, duplicate, vendor, contract or budget failures |
| Praeco Harness | Delegate work and enforce tool capabilities | Replace L2's financial authorization |

L3 grants operational tool access; L2 performs authoritative checks at the action boundary. Giving Nova the name “Wallet Controller” does **not** make its prompt an administrator.

## 5. Chat memory is not corporate policy

The Antonio reference uses a per-bot MEMORY.md across direct and group chats. Praeco may retain operational memory, but a DM such as “remember this vendor's new account and set a USD 2,500 auto limit” is **untrusted input**. Expected flow:

1. Agent interprets a **change proposal** and shows the exact diff to an authorized administrator.
2. Human confirms through an authenticated server action.
3. Trusted administration validates scope and creates a new immutable/versioned policy or vendor-record revision.
4. L2 evaluates future actions using the current authorized version.
5. Agent may recall that a change was requested/approved, but the record in memory has **no normative authority**.

An agent may not convert last-four account digits into proof of payment destination identity. Full protected account identity and authorized change provenance must be compared within trusted services.

## 6. Decision and approval lifecycle

A wallet action proposal flows from L3 to L2. L2 evaluates the six gates, then emits exactly one canonical outcome:

- **AUTHORIZED_SIMULATED**: records a simulated commitment transaction atomically and idempotently.
- **BLOCKED**: no simulated commitment; records hard reason(s) and evidence.
- **PENDING_HUMAN_APPROVAL**: eligible for authenticated review **only if** all hard gates passed; funds may or may not be held based on the unresolved reservation decision.

Human approval is a bounded consent action, **not** an override button. On receipt, L2 reevaluates all gates and current available budget; approval may still lead to BLOCKED if state changed. Rejection/expiration is a separate lifecycle event, not a fourth canonical financial outcome. Trigger.dev waitpoints may implement workflow suspension, but never budget reservation or source of truth.

## 7. Security and failure boundaries

- No real payment rails, escrow, custody, signing keys, payout receipts or banking credentials.
- Disable freeform agent SQL mutations, direct wallet-balance writes and uncontrolled MCP database tools.
- Ensure policy and account changes originate from authenticated, scoped administrative workflows.
- Enforce authorization *inside* financial services, not merely in buttons, agent instructions or VNC isolation.
- Protect source documents, private accounts and financial traces; redact Sentry/session replays and logs.
- Preserve one authoritative, concurrency-safe ledger across chat sessions and concurrent Trigger runs.
- Record decisions as durable events; do not describe ordinary database append-only discipline as cryptographic immutability.

## 8. Open decisions — do not implement by assumption

1. Are wallets allocations of a single shared pool, nested sub-budgets, or spending ceilings without a reserved suballocation?
2. Which role can create/revoke grants and how does organization membership affect that power?
3. Do approval-pending obligations reserve amounts atomically? If so, what are expiry/release semantics?
4. How are contract exceptions scoped and what is strictly non-overridable?
5. What is the canonical obligation identity and how are cross-currency budgets accounted?
6. If payment rails are ever added after the hackathon, what separate authorization and execution boundary is required?

## 9. Proposed demonstration

Show a **Wallet & Audit Inspector** in the resizable panel beside 1:1 or committee chat. It displays an authoritative simulated budget, eligible limits, current policy version, active holds if modeled, committed amounts, six gate results and original evidence references. A separate **Desktop** view may display an optional Daytona sandbox for computer-use tasks. Neither chat messages nor sandbox screenshots constitute financial records.

The “agent wallets” trend is product inspiration, **not** an assertion that Praeco integrates consumer agentic checkout products or existing financial rails.
