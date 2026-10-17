# Praeco — Instructions for Codex and AI coding agents

## Product

Praeco is a **domain-specific agent harness for autonomous, governed financial operations**, initially solving the 30X Hackathon Blinka Accounts Payable challenge. The repository must remain public-safe, synthetic-only and free of credentials.

## Commit discipline

**Mandatory Conventional Commits** for every commit and PR title: `type(scope): imperative summary`.

Examples: `feat(l1): add source verification port`, `test(l2): reject insufficient budget`, `docs(architecture): specify replay ownership`.

See `docs/CONTRIBUTING.md`.

## Frozen and pending boundaries

- **L1 v3.0.0** is the accepted interface/design baseline, **not** implemented or production-proven. Preserve it. It handles immutable document sources, extraction, evidence grounding and deterministic currency normalization. It NEVER makes financial decisions.
- **L2** is the sole authoritative deterministic decision kernel. Six gates: evidence integrity; duplicate; allowlisted beneficiary/account; contract match; budget; auto-approval threshold. Outcomes are `AUTHORIZED_SIMULATED`, `BLOCKED`, `PENDING_HUMAN_APPROVAL`. Policy/ledger contracts remain under design.
- **L3** is Praeco Agent Harness: agents, delegations, scoped capabilities, HITL, durable execution, recovery and cross-source payable-case correlation. Pi, Daytona and external workflow services are architectural candidates, not yet mandatory dependencies.
- **DEMO-001** seeds wholly synthetic enterprise data and inputs. Keep `ground-truth` / expected outcome files inaccessible to application runtime and LLM prompts. Isolated scenario replay must not share ledgers; separate sequential replay can share a ledger with explicit semantics.
- **DEMO-002** AgentMail is a proposed inbound adapter. Email contents are untrusted; providers/remitters are never verified merely by their email address.

## Financial safety

No real payments. Never mark simulated authorization `PAID`; never bypass hard policy gates even for human approvals. Fail closed for missing, conflicting, invalid or unverified critical evidence. Use exact decimal arithmetic and pinned synthetic FX rates (1 USD = 4,000 COP; 1 USD = 20 MXN) in the demo. Do not expose vendor account numbers in logs. Distinguish technical ingestion idempotency from business-invoice duplicate detection.

## Implementation workflow

1. Read specifications before changing cross-layer boundaries.
2. Implement narrowly scoped vertical slices with tests.
3. Keep golden-set outcomes test-only; the runtime must derive decisions independently.
4. Use TypeScript strict; prefer typed ports, Zod, Vitest and explicit adapters.
5. Do not claim tests were run unless they were run.
6. Do not modify authoritative L1 contract without an explicit versioned ADR.
7. Keep commits small and Conventional Commit compliant.
