# ADR-001 — Financial evidence boundaries

**Status:** Accepted initial baseline
**Date:** 2026-10-17

## Context

Praeco needs to reason about synthetic invoices from diverse formats and currencies while ensuring evidence extraction can never masquerade as payment authorization. Some payable cases may have multiple sources (e.g. PDF plus explanatory chat); duplicate detection and budget spending require authoritative L2 state.

## Decision

- L1 exclusively owns immutable source registration, adaptive parsing, structured extraction, source-grounded evidence, independent trusted verification and deterministic money normalization.
- Use stable provider-independent contracts in `packages/evidence-intelligence/src/contracts.ts`.
- Normalize from configured quote-per-USD rates rather than specializing the design to one currency. USD identity, fictional COP and MXN quote support, HALF_EVEN, exact decimal and persisted rate provenance are required.
- Retain each document independently; L3 correlates multiple sources and L2 evaluates contracts, vendor allowlists, duplicate obligations, budgets and thresholds.
- For each canonical demo case, define synthetic initial financial state independently. Golden expected decisions live only in testing and must never be injected into production runtime.
- Changes to the baseline require a new explicit ADR and, for incompatible contracts, a safe schema migration.

## Consequences

L1 can produce a fully verified invoice that L2 later blocks for financial reasons. The reverse must never happen: downstream components must not autoauthorize a non-ready envelope. Contract readiness does not imply implementation or proven OCR performance. No payments are executed.
