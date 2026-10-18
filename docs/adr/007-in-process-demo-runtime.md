# ADR-007 — In-Process Deterministic Demo Runtime (P0 Stand-Ins)

**Status:** Accepted for the hackathon demo runtime; explicit labeled deviation from the ADR-004/005 production composition, with swap-in targets preserved.
**Date:** 2026-10-18
**Depends on:** ADR-001–006, L3 implementation contract

## Context

ADR-004/005 ratify Trigger.dev as the exclusive P0 durable workflow owner, Neon PostgreSQL as the authoritative operational store, and the Vercel AI SDK for bounded model loops. The hackathon demo must run offline and deterministically in CI and on demo day, without provisioned external services, while slices B–F are built on that constraint now.

## Decision

For the P0 demo runtime, L3 executes on explicit in-process deterministic stand-ins behind ports:

- **Workflow driver:** an in-process `WorkflowRunner` implementing the assignment lifecycle loop (bounded steps, checkpoints, resume-from-state). It is **not** a durable orchestrator and makes no durability claim; a process crash loses in-flight runs by design, and recovery demonstrations reconstruct from store state rather than from the runner.
- **Operational store:** the in-memory `HarnessStore` implementation behind the `HarnessStore` port. It is authoritative only within one process. A Postgres/Neon implementation of the same port is the swap-in target and remains out of scope for the demo.
- **Reconciler cadence:** an in-process timer in the demo app with a configurable interval, standing in for a Trigger.dev scheduled task.
- **Model calls:** deterministic scripted responses in tests and CI. Live provider keys are local-only and never enter CI, tests or committed files (precedent: L1 OpenRouter key handling).

## Non-negotiables preserved

- L2 remains the sole financial authority; the runner, specialists and stores never write L2 state, and all L2 calls go through the protected ports with stable intent keys.
- Workflow states remain distinct from L2 financial verdicts; slice A's terminal-state and fencing semantics hold unchanged.
- `AUTHORIZED_SIMULATED` is never `PAID` on any surface.

## Consequences

- All "durable"/"authoritative" qualities in the demo are process-local and simulated; documentation and UI must not claim cross-process durability.
- Swap-in path: a Trigger.dev workflow wrapper and a Postgres `HarnessStore` implementation replace the stand-ins behind the same ports without changing L2/L3 domain code; that swap requires its own validation slice before any production claim.
- CI stays offline and deterministic: a test requiring network or a live model key is a failing test by definition.

## Exit-criteria deltas binding on slices B–F

1. Slice B–F tests run offline with scripted model responses; no live keys, no network in CI.
2. Slices C/D run all eight Blinka scenarios through real L1 processing (demo-day corpus), including case 04's two-source case (PDF invoice plus supplemental chat).
3. Slice E implements resolve-before-subscribe: approval status is re-checked before and after installing any wait; wait tokens are notification only.
4. Slice F asserts no surface prints "PAGÓ", and email intake is a direct inbound webhook with exact-byte attachment handling until Chat SDK email support is validated.
