/**
 * ADR-003 financial store schema. All monetary columns are NUMERIC so that
 * exact decimal arithmetic happens inside PostgreSQL, never in floating point.
 * Migrations are idempotent (CREATE TABLE IF NOT EXISTS) for the demo scope.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS budgets (
  tenant_id     TEXT NOT NULL,
  budget_id     TEXT NOT NULL,
  period        TEXT NOT NULL,
  limit_usd     NUMERIC NOT NULL,
  committed_usd NUMERIC NOT NULL,
  spend_revision BIGINT NOT NULL DEFAULT 1,
  limit_revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, budget_id)
);

CREATE TABLE IF NOT EXISTS obligations (
  tenant_id          TEXT NOT NULL,
  canonical_key      TEXT NOT NULL,
  obligation_id      TEXT NOT NULL,
  intent_digest_sha256 TEXT NOT NULL,
  committed_usd      NUMERIC NOT NULL,
  authorized_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, canonical_key),
  UNIQUE (tenant_id, obligation_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  record      JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_receipts (
  tenant_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  decision_id     TEXT NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ledger_events (
  event_id    TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);
`;
