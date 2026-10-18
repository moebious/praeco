# Praeco — Instructions for Codex and AI coding agents

## Product

Praeco is a **domain-specific agent harness for autonomous, governed financial operations**, initially solving the 30X Hackathon Blinka Accounts Payable challenge. The repository must remain public-safe, synthetic-only and free of credentials.

## Commit discipline

**Mandatory Conventional Commits** for every commit and PR title: `type(scope): imperative summary`.

Examples: `feat(l1): add source verification port`, `test(l2): reject insufficient budget`, `docs(architecture): specify replay ownership`.

See `docs/CONTRIBUTING.md`.

- Never add `Co-authored-by` trailers or any AI-agent attribution to commit messages; commits carry only the configured author identity.
- Never commit directly to `main`. All work lands on a feature branch and merges through a pull request.

## Frozen and pending boundaries

- **L2** is the sole authoritative deterministic decision kernel. Six gates: evidence integrity; duplicate; allowlisted beneficiary/account; contract match; budget; auto-approval threshold. Outcomes are `AUTHORIZED_SIMULATED`, `BLOCKED`, `PENDING_HUMAN_APPROVAL`. The kernel, approval lifecycle, and trusted L1 reader adapter are implemented; the legacy operations dashboard is retired in favor of the unified finance workspace. An optional PostgreSQL commit adapter atomically persists authorized commits and approval-time commits; the default demo still uses the synthetic in-memory ledger. Pending approval lifecycle and non-commit decision state are not SQL-backed, so this is a partial persistence integration, not full ADR-003 completion or production readiness. Before changing financial behavior, read ADR-002/003 and `docs/architecture/l2-implementation-contract.md`.
- **L3** is the Praeco Agent Harness: agents, delegations, scoped capabilities, HITL, durable execution, recovery and cross-source payable-case correlation. The P0 build runs on the **in-process deterministic demo runtime of ADR-007** (in-memory `HarnessStore`, workflow runner, reconciler timer and scripted models, all behind ports); Trigger.dev and Neon PostgreSQL are swap-in targets, so **never claim cross-process durability** in docs or UI. Slices B–F must honor ADR-007's exit-criteria deltas: offline deterministic tests with no live keys, all eight golden scenarios through real L1, resolve-before-subscribe on waits, no paid-equivalent wording, exact-byte email intake.
- **DEMO-001** seeds wholly synthetic enterprise data and inputs. Keep `ground-truth` / expected outcome files inaccessible to application runtime and LLM prompts. Isolated scenario replay must not share ledgers; separate sequential replay can share a ledger with explicit semantics.
- **DEMO-002** AgentMail is a proposed inbound adapter. Email contents are untrusted; providers/remitters are never verified merely by their email address.

## Financial safety

No real payments. Never mark simulated authorization `PAID`; never bypass hard policy gates even for human approvals. User-facing surfaces display `AUTHORIZED_SIMULATED` explicitly — never `PAID` or a paid equivalent in any language (for example "PAGÓ"). Fail closed for missing, conflicting, invalid or unverified critical evidence. Use exact decimal arithmetic and pinned synthetic FX rates (1 USD = 4,000 COP; 1 USD = 20 MXN) in the demo. Do not expose vendor account numbers in logs. Distinguish technical ingestion idempotency from business-invoice duplicate detection.

## Implementation workflow

1. Read specifications before changing cross-layer boundaries, including ADR-007 for the demo runtime.
2. Implement narrowly scoped vertical slices with tests.
3. Keep golden-set outcomes test-only; the runtime must derive decisions independently.
4. Use TypeScript strict; prefer typed ports, Zod, Vitest and explicit adapters.
5. `npm run check` (build, then typecheck, then tests) is the validation gate. Cross-workspace types resolve through built `dist/`, so never run `npm run typecheck` alone on a fresh tree.
6. Do not claim tests were run unless they were run.
7. Do not modify authoritative L1 contract without an explicit versioned ADR; CI rejects a changed contract hash.
8. Keep commits small and Conventional Commit compliant.
9. When sharing a working tree with another agent, stage only the files you changed; never commit another agent's uncommitted work.
10. Never rewrite published history or force-push without the owner's explicit instruction.
