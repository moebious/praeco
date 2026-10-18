# ADR-004 — Domain-Specific Agent Harness, Identity and Authority

**Status:** Accepted; implementation pending
**Date:** 2026-10-17
**Scope:** Praeco L3 / 30X Blinka synthetic Accounts Payable MVP
**Depends on:** ADR-001, ADR-002, ADR-003

## Context

Praeco is a persistent, multichannel financial AI teammate, not a universal personal assistant and not a payment processor. Its work begins in messages or documents, persists beyond individual chat turns, and ends in verifiable financial outcomes. A finance-specialist persona or an LLM's tool call is not an authorization principal.

L1 owns verifiable documentary evidence. L2 is the only financial policy and simulated commitment authority; its six gates and three canonical financial outcomes must not be reproduced in prompts or in L3. L3 owns the lifecycle of work, channels, identity resolution, bounded operational tools, agent context and recovery.

## Decision

1. **One Praeco service identity per tenant**, with stable `AgentPrincipal` and distinct `WorkerVersion`. Vera (evidence), Kael (policy explanation), and Nova (wallet/operations) are initial specialist **roles/capability profiles** inside the harness, not automatically three separate processes, bank wallets, tenant identities or independently trusted agents. Future separate workers need a new isolation and ownership decision.
2. The authenticated human principal, organization, platform/channel user identity, Praeco agent principal, and operational `Assignment` are distinct. The server derives tenant and actor from authenticated context; neither prompt, email sender name nor channel display handle grants authority.
3. A channel message is untrusted input. L3 may transform it into a proposal after identity and capability checks, but it may never cause direct writes to L2 budgets, vendor account master, policies, approvals or ledger.
4. Every financial request to L2 uses trusted backend authorization and a stable idempotency key, carries references to stored L1 envelopes and PayableCase, and is answered by an authoritative L2 decision record. L3 must not infer `AUTHORIZED_SIMULATED` from the model's text.
5. L3 keeps operational state (`PayableCase`, `Assignment`, `AgentRun`, `ExecutionEvent`, conversation links and provider event receipts) separately from L1 artifacts and the L2 financial ledger.
6. Persistent memory consists of **untrusted operational notes and retrieval hints**; it never overrides authenticated identity, grants, vendor records, signed approvals or L1 verification. Revoked permissions take effect on the next protected action even if the conversation remembers an earlier grant.
7. P0 runs synthetic-only; never move real money, handle live provider banking credentials, or produce a status of PAID. `AUTHORIZED_SIMULATED` is explicit in user-facing UI and notifications.

## Runtime composition (P0)

- **Vercel AI SDK** supplies model calls, bounded tool loops and optional specialized response compositions. Limit tool inventory per trusted actor/phase, bound step count and budgets, and keep protected tool implementation server-side.
- **Trigger.dev** is the sole durable owner of each financial assignment workflow in P0. It may schedule L1 and L2 calls, retry safe tasks, suspend waits and emit events.
- **Vercel Chat SDK** supplies channel adapters, webhook handling and provider conversation state. It does **not** become an Assignment store or authorization service.
- **Praeco Postgres** (planned Neon + Drizzle) stores canonical operational identities, assignments, case associations, binding records, command deduplication and event outbox. Chat SDK may use a separate namespaced Postgres state adapter; that state is transport infrastructure, not canonical finance state.
- **Eve and Pi Durable** are outside this baseline, including the scheduled implementation roadmap. Reconsideration requires a new ADR proving unique ownership and migration semantics; neither is a fallback executor.
- **Optional Daytona/VM and Link Wallet** are future, individually permissioned tool adapters. They are not needed for P0.

## Trust boundaries

| Boundary | Allowed | Forbidden |
| --- | --- | --- |
| Channel -> L3 | Untrusted message, attachment reference, provider message ID | Platform handle as FinanceAdmin authority |
| L3 -> L1 | Server-side ingestion and trusted envelope references | Creating a READY invoice from ERP JSON or a prompt |
| L3 -> L2 | Scoped `preview` / `decideAndCommit` using trusted backend actor | Agent-generated grant, bank account approval, direct ledger SQL |
| L2 -> L3 | Decision ID, gate summaries and approval request reference | Editing L2 result via model commentary |
| L3 -> Human | Notification/link for authenticated consent | Email/Telegram reply silently treated as authorized approval |
| L3 -> Sandbox | Short-lived, task-scoped capabilities and staged files | Financial SQL credentials or unrestricted payment tools |

## Consequences

The team UI may present a conversation among Vera/Kael/Nova without creating separate durable agents. Specialist role and worker version are execution attributes, not additional tenant service principals. A reply can end while its Assignment remains running or awaiting review. The same case can be followed on multiple channels only after explicit user linking within the correct installation. Retried messages cannot create extra simulated budget commitments. Agent memory and the chat provider are never the business system of record. See the [glossary](../../GLOSSARY.md) for the distinctions between case, Assignment, principal and approval lifecycle.

## Rejected alternatives

- Full Eve/Pi Durable adoption for the hackathon solely to obtain persistence or chat integration.
- One wallet or database credential per persona as an implied source of financial authorization.
- A single long prompt that acts as a vendor register, approval policy and ledger.
- Auto-linking email addresses, Telegram IDs and Slack handles by display name.
- Universal personal-assistant scope displacing Accounts Payable P0.

## Acceptance

A compromised or mistaken agent must not: (1) create a trusted document without L1 validation, (2) bypass G1–G6, (3) approve a pending expense without an authenticated FinanceAdmin L2 action, (4) cross tenant/channel identity boundaries, or (5) mark a simulated commitment PAID. Test these properties before claiming an implemented secure harness.

**Ratification:** this proposed ADR becomes normative only on review and merge.
