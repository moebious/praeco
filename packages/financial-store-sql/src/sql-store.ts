import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SCHEMA_DDL } from './schema.js';

export interface BudgetSeed {
  tenantId: string;
  budgetId: string;
  period: string;
  limitUsd: string;
  committedUsd?: string;
}

export interface CommitPayableCommand {
  tenantId: string;
  decisionId: string;
  commitmentId: string;
  /** Canonical payable key: tenant + vendor tax ID + invoice number. */
  canonicalKey: string;
  intentDigestSha256: string;
  /** Exact decimal string, e.g. "2200.00". Never a float. */
  amountUsd: string;
  budgetId: string;
  idempotencyKey: string;
  payloadDigest: string;
  decisionRecord: unknown;
  /** ISO instant of the authorizing decision. */
  occurredAt: string;
}

export type CommitPayableResult =
  | { status: 'COMMITTED'; decisionId: string; remainingUsd: string }
  | { status: 'IDEMPOTENT_REPLAY'; decisionId: string }
  | { status: 'DUPLICATE_OBLIGATION'; canonicalKey: string }
  | { status: 'CONFLICTING_OBLIGATION'; canonicalKey: string }
  | { status: 'INSUFFICIENT_BUDGET'; availableUsd: string };

/**
 * SQL-backed authoritative store for the ADR-003 financial transaction
 * boundary. The commit path is one database transaction: idempotency
 * serialization/check, obligation claim (unique canonical key), budget row
 * lock (SELECT ... FOR UPDATE), atomic budget debit, decision record,
 * idempotency receipt and ledger event. Concurrent payables serialize on the
 * budget row; a duplicate payable rolls back with zero budget movement.
 */
export class SqlFinancialStore {
  private constructor(private readonly pool: Pool) {}

  public static async connect(databaseUrl: string): Promise<SqlFinancialStore> {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // CREATE TABLE IF NOT EXISTS can still race in PostgreSQL's type
        // catalog. Serialize schema initialization across independent pools.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['praeco-schema', 'financial-store-sql']
        );
        await client.query(SCHEMA_DDL);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new SqlFinancialStore(pool);
  }

  public async seedBudget(seed: BudgetSeed): Promise<void> {
    await this.pool.query(
      `INSERT INTO budgets (tenant_id, budget_id, period, limit_usd, committed_usd)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric)
       ON CONFLICT (tenant_id, budget_id) DO NOTHING`,
      [seed.tenantId, seed.budgetId, seed.period, seed.limitUsd, seed.committedUsd ?? '0.00']
    );
  }

  public async getCommittedUsd(tenantId: string, budgetId: string): Promise<string> {
    const result = await this.pool.query(
      `SELECT committed_usd::text AS committed_usd FROM budgets WHERE tenant_id = $1 AND budget_id = $2`,
      [tenantId, budgetId]
    );
    if (!result.rowCount || result.rowCount === 0) {
      throw new Error(`BUDGET_NOT_FOUND: ${budgetId}`);
    }
    return result.rows[0]!.committed_usd as string;
  }

  /** Returns the persisted decision record for idempotent replay, or null. */
  public async getDecisionRecord(decisionId: string): Promise<unknown | null> {
    const result = await this.pool.query(
      `SELECT record FROM decisions WHERE decision_id = $1`,
      [decisionId]
    );
    if (!result.rowCount || result.rowCount === 0) {
      return null;
    }
    const raw = result.rows[0]!.record;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  public async commitPayable(command: CommitPayableCommand): Promise<CommitPayableResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        // Serialize concurrent retries before checking the receipt. The
        // two-key advisory lock is transaction-scoped, and hash collisions
        // only add harmless contention.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [command.tenantId, command.idempotencyKey]
        );

        // 1. Idempotency first, scoped to tenant + key (ADR-003).
        const receipt = await client.query(
          `SELECT payload_digest, decision_id FROM idempotency_receipts
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [command.tenantId, command.idempotencyKey]
        );
        if (receipt.rowCount && receipt.rowCount > 0) {
          const row = receipt.rows[0]!;
          if (row.payload_digest !== command.payloadDigest) {
            throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
          }
          await client.query('COMMIT');
          return { status: 'IDEMPOTENT_REPLAY', decisionId: row.decision_id as string };
        }

        // 2. Claim the obligation before checking budget so duplicate/conflict
        // gate precedence remains deterministic even when funds are exhausted.
        // A failed budget check rolls this claim back with the transaction.
        const obligation = await client.query(
          `INSERT INTO obligations
             (tenant_id, canonical_key, obligation_id, intent_digest_sha256, committed_usd, authorized_at)
           VALUES ($1, $2, $3, $4, $5::numeric, $6)
           ON CONFLICT (tenant_id, canonical_key) DO NOTHING
           RETURNING obligation_id`,
          [
            command.tenantId,
            command.canonicalKey,
            `ob-${randomUUID()}`,
            command.intentDigestSha256,
            command.amountUsd,
            command.occurredAt,
          ]
        );
        if (!obligation.rowCount || obligation.rowCount === 0) {
          const prior = await client.query(
            `SELECT intent_digest_sha256 FROM obligations
             WHERE tenant_id = $1 AND canonical_key = $2`,
            [command.tenantId, command.canonicalKey]
          );
          if (!prior.rowCount || prior.rowCount === 0) {
            throw new Error('OBLIGATION_CONFLICT_ROW_NOT_FOUND');
          }
          const status =
            prior.rows[0]!.intent_digest_sha256 === command.intentDigestSha256
              ? 'DUPLICATE_OBLIGATION'
              : 'CONFLICTING_OBLIGATION';
          await client.query('ROLLBACK');
          return { status, canonicalKey: command.canonicalKey };
        }

        // 3. Lock and check the budget in the same transaction. Exact decimal
        // comparisons happen inside PostgreSQL.
        const budget = await client.query(
          `SELECT (limit_usd - committed_usd)::text AS available_usd
           FROM budgets WHERE tenant_id = $1 AND budget_id = $2 FOR UPDATE`,
          [command.tenantId, command.budgetId]
        );
        if (!budget.rowCount || budget.rowCount === 0) {
          throw new Error(`BUDGET_NOT_FOUND: ${command.budgetId}`);
        }
        const availableUsd = budget.rows[0]!.available_usd as string;
        const fits = await client.query(
          `SELECT ($1::numeric <= $2::numeric) AS fits`,
          [command.amountUsd, availableUsd]
        );
        if (!fits.rows[0]!.fits) {
          await client.query('ROLLBACK');
          return { status: 'INSUFFICIENT_BUDGET', availableUsd };
        }

        // 4. Atomic debit in the same transaction as the obligation claim.
        await client.query(
          `UPDATE budgets
           SET committed_usd = committed_usd + $1::numeric, spend_revision = spend_revision + 1
           WHERE tenant_id = $2 AND budget_id = $3`,
          [command.amountUsd, command.tenantId, command.budgetId]
        );

        // 5. Commitment, decision, receipt, and ledger event share one commit.
        await client.query(
          `INSERT INTO commitments
             (tenant_id, commitment_id, canonical_payable_key, budget_id, unrounded_usd, decision_id, committed_at)
           VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)`,
          [
            command.tenantId,
            command.commitmentId,
            command.canonicalKey,
            command.budgetId,
            command.amountUsd,
            command.decisionId,
            command.occurredAt,
          ]
        );
        await client.query(
          `INSERT INTO decisions (decision_id, tenant_id, outcome, occurred_at, record)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            command.decisionId,
            command.tenantId,
            'AUTHORIZED_SIMULATED',
            command.occurredAt,
            JSON.stringify(command.decisionRecord),
          ]
        );
        await client.query(
          `INSERT INTO idempotency_receipts (tenant_id, idempotency_key, payload_digest, decision_id, recorded_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [command.tenantId, command.idempotencyKey, command.payloadDigest, command.decisionId, command.occurredAt]
        );
        await client.query(
          `INSERT INTO ledger_events (event_id, tenant_id, event_type, payload, occurred_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            `evt-${randomUUID()}`,
            command.tenantId,
            'SIMULATED_AUTHORIZATION_COMMITTED',
            JSON.stringify({ decisionId: command.decisionId, canonicalKey: command.canonicalKey, unroundedUsd: command.amountUsd }),
            command.occurredAt,
          ]
        );

        const remaining = await client.query(
          `SELECT (limit_usd - committed_usd)::text AS remaining_usd
           FROM budgets WHERE tenant_id = $1 AND budget_id = $2`,
          [command.tenantId, command.budgetId]
        );
        await client.query('COMMIT');
        return { status: 'COMMITTED', decisionId: command.decisionId, remainingUsd: remaining.rows[0]!.remaining_usd as string };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
