import type { FinancialDecisionRecord } from './types.js';

/**
 * Authoritative commit backend for the ADR-003 financial transaction
 * boundary. When configured, both ledger commit paths (decideAndCommit and
 * approval resolution) delegate the durable, race-safe mutation to the port:
 * idempotency, obligation claim, budget debit and the durable records all
 * happen inside the backend's transaction. The in-memory store mirrors the
 * authoritative outcome so read paths stay consistent within the process.
 */
export interface AuthoritativeCommitCommand {
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
  decisionRecord: FinancialDecisionRecord;
  /** ISO instant of the authorizing decision. */
  occurredAt: string;
}

export type AuthoritativeCommitResult =
  | { status: 'COMMITTED'; decisionId: string; budgetCommittedUsd: string | null }
  | {
      status: 'IDEMPOTENT_REPLAY';
      decisionId: string;
      decisionRecord: FinancialDecisionRecord;
      budgetCommittedUsd: string | null;
    }
  | { status: 'DUPLICATE_OBLIGATION'; canonicalKey: string; budgetCommittedUsd: string | null }
  | { status: 'CONFLICTING_OBLIGATION'; canonicalKey: string; budgetCommittedUsd: string | null }
  | { status: 'INSUFFICIENT_BUDGET'; availableUsd: string; budgetCommittedUsd: string | null };

export interface AuthoritativeCommitPort {
  commitAuthorizedPayable(command: AuthoritativeCommitCommand): Promise<AuthoritativeCommitResult>;
}
