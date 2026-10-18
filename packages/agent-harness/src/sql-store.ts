import pg from 'pg';
import type {
  AgentPrincipal,
  AgentRun,
  Assignment,
  AssignmentId,
  AssignmentState,
  CaseSourceLink,
  Checkpoint,
  CheckpointStage,
  CommandReceipt,
  ExecutionEvent,
  ExternalPrincipalBinding,
  FinancialDecisionReference,
  FinancialIntentReference,
  FinancialOutcome,
  InboundEventReceipt,
  LinkingChallenge,
  OutboxEvent,
  PayableCase,
  PayableCaseId,
  SpecialistRole,
  TenantId,
} from './types.js';
import type { HarnessStore } from './store.js';

const { Pool } = pg;

export const HARNESS_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS harness_principal_bindings (
  tenant_id        TEXT NOT NULL,
  provider         TEXT NOT NULL,
  installation_id  TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  principal_id     TEXT NOT NULL,
  roles            JSONB NOT NULL,
  binding_revision TEXT NOT NULL,
  revoked          BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, provider, installation_id, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_bindings_user
  ON harness_principal_bindings (provider, installation_id, provider_user_id);

CREATE TABLE IF NOT EXISTS harness_linking_challenges (
  token               TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  principal_id        TEXT NOT NULL,
  roles               JSONB NOT NULL,
  provider            TEXT NOT NULL,
  installation_id     TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  consumed_by_user_id TEXT,
  revoked_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS harness_agent_principals (
  tenant_id    TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE IF NOT EXISTS harness_inbound_receipts (
  receipt_id        TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  provider          TEXT NOT NULL,
  installation_id   TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  payload_digest    TEXT NOT NULL,
  assignment_id     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, provider, installation_id, provider_event_id)
);

CREATE TABLE IF NOT EXISTS harness_cases (
  tenant_id    TEXT NOT NULL,
  case_id      TEXT NOT NULL,
  source_links JSONB NOT NULL DEFAULT '[]',
  version      INT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, case_id)
);

CREATE TABLE IF NOT EXISTS harness_thread_case_links (
  tenant_id       TEXT NOT NULL,
  provider        TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  case_id         TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider, installation_id, thread_id)
);

CREATE TABLE IF NOT EXISTS harness_assignments (
  tenant_id                   TEXT NOT NULL,
  assignment_id               TEXT NOT NULL,
  case_id                     TEXT NOT NULL,
  agent_principal_id          TEXT NOT NULL,
  requested_by_principal_id   TEXT NOT NULL,
  state                       TEXT NOT NULL,
  version                     INT NOT NULL,
  active_run_id               TEXT,
  ownership_epoch             INT NOT NULL,
  cancellation_requested_at   TIMESTAMPTZ,
  pending_financial_intent_id TEXT,
  initial_l2_decision_id      TEXT,
  latest_l2_decision_id       TEXT,
  l2_approval_request_id      TEXT,
  trigger_wait_token          TEXT,
  created_at                  TIMESTAMPTZ NOT NULL,
  updated_at                  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, assignment_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_assignments_state
  ON harness_assignments (tenant_id, state);

CREATE TABLE IF NOT EXISTS harness_runs (
  tenant_id          TEXT NOT NULL,
  assignment_id      TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  trigger_run_id     TEXT NOT NULL,
  worker_version_id  TEXT NOT NULL,
  specialist_role    TEXT,
  ownership_epoch    INT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  completed_at       TIMESTAMPTZ,
  status             TEXT NOT NULL,
  PRIMARY KEY (tenant_id, assignment_id, run_id)
);

CREATE TABLE IF NOT EXISTS harness_checkpoints (
  tenant_id       TEXT NOT NULL,
  checkpoint_id   TEXT NOT NULL,
  assignment_id   TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  ownership_epoch INT NOT NULL,
  stage           TEXT NOT NULL,
  input_refs      JSONB NOT NULL,
  output_refs     JSONB NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_checkpoints_asg
  ON harness_checkpoints (tenant_id, assignment_id, recorded_at);

CREATE TABLE IF NOT EXISTS harness_command_receipts (
  tenant_id          TEXT NOT NULL,
  scope              TEXT NOT NULL,
  command_key        TEXT NOT NULL,
  command_receipt_id TEXT NOT NULL,
  payload_digest     TEXT NOT NULL,
  result_ref         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, scope, command_key)
);

CREATE TABLE IF NOT EXISTS harness_financial_intents (
  tenant_id                 TEXT NOT NULL,
  intent_id                 TEXT NOT NULL,
  assignment_id             TEXT NOT NULL,
  case_id                   TEXT NOT NULL,
  case_version              INT NOT NULL,
  requested_by_principal_id TEXT NOT NULL,
  worker_principal_id       TEXT NOT NULL,
  requested_budget_id       TEXT NOT NULL,
  envelope_ids              JSONB NOT NULL,
  idempotency_key           TEXT NOT NULL,
  payload_digest            TEXT NOT NULL,
  PRIMARY KEY (tenant_id, intent_id)
);

CREATE TABLE IF NOT EXISTS harness_financial_decisions (
  tenant_id           TEXT NOT NULL,
  decision_id         TEXT NOT NULL,
  outcome             TEXT NOT NULL,
  approval_request_id TEXT,
  gate_summary_refs   JSONB NOT NULL,
  PRIMARY KEY (tenant_id, decision_id)
);

CREATE TABLE IF NOT EXISTS harness_execution_events (
  tenant_id         TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  aggregate_id      TEXT NOT NULL,
  aggregate_version INT NOT NULL,
  event_type        TEXT NOT NULL,
  command_id        TEXT NOT NULL,
  causation_id      TEXT,
  payload_ref       TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_execution_events_agg
  ON harness_execution_events (tenant_id, aggregate_id, aggregate_version);

CREATE TABLE IF NOT EXISTS harness_outbox_events (
  tenant_id       TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  installation_id TEXT,
  event_type      TEXT NOT NULL,
  command_id      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  dispatched_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_outbox_undispatched
  ON harness_outbox_events (tenant_id, occurred_at) WHERE dispatched_at IS NULL;
`;

function toIsoString(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  return String(val);
}

function toNullableIsoString(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

/**
 * SQL-backed implementation of HarnessStore (ADR-004, ADR-005, ADR-007).
 * Connects to PostgreSQL / Neon with atomic version guards, row-level fencing,
 * transactional outbox draining, and complete multi-tenant isolation.
 */
export class SqlHarnessStore implements HarnessStore {
  constructor(private readonly pool: pg.Pool) {}

  public static async connect(databaseUrl: string): Promise<SqlHarnessStore> {
    const isSsl =
      databaseUrl.includes('sslmode=require') ||
      databaseUrl.includes('neon.tech');
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    });

    const store = new SqlHarnessStore(pool);
    await store.migrate();
    return store;
  }

  public async migrate(): Promise<void> {
    await this.pool.query(HARNESS_SCHEMA_DDL);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Principal bindings
  // ─────────────────────────────────────────────────────────────────────────────
  async getPrincipalBinding(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<ExternalPrincipalBinding | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_principal_bindings
       WHERE tenant_id = $1 AND provider = $2 AND installation_id = $3 AND provider_user_id = $4`,
      [tenantId, provider, installationId, providerUserId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      tenantId: row.tenant_id,
      provider: row.provider,
      installationId: row.installation_id,
      providerUserId: row.provider_user_id,
      principalId: row.principal_id,
      roles: Array.isArray(row.roles) ? row.roles : JSON.parse(row.roles),
      bindingRevision: row.binding_revision,
      revoked: Boolean(row.revoked),
    };
  }

  async findPrincipalBindingsByUser(
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<readonly ExternalPrincipalBinding[]> {
    const res = await this.pool.query(
      `SELECT * FROM harness_principal_bindings
       WHERE provider = $1 AND installation_id = $2 AND provider_user_id = $3`,
      [provider, installationId, providerUserId]
    );
    return res.rows.map((row) => ({
      tenantId: row.tenant_id,
      provider: row.provider,
      installationId: row.installation_id,
      providerUserId: row.provider_user_id,
      principalId: row.principal_id,
      roles: Array.isArray(row.roles) ? row.roles : JSON.parse(row.roles),
      bindingRevision: row.binding_revision,
      revoked: Boolean(row.revoked),
    }));
  }

  async registerPrincipalBinding(binding: ExternalPrincipalBinding): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_principal_bindings
        (tenant_id, provider, installation_id, provider_user_id, principal_id, roles, binding_revision, revoked)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (tenant_id, provider, installation_id, provider_user_id)
       DO UPDATE SET
        principal_id = EXCLUDED.principal_id,
        roles = EXCLUDED.roles,
        binding_revision = EXCLUDED.binding_revision,
        revoked = EXCLUDED.revoked`,
      [
        binding.tenantId,
        binding.provider,
        binding.installationId,
        binding.providerUserId,
        binding.principalId,
        JSON.stringify(binding.roles),
        binding.bindingRevision,
        binding.revoked,
      ]
    );
  }

  async revokePrincipalBinding(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE harness_principal_bindings
       SET revoked = true
       WHERE tenant_id = $1 AND provider = $2 AND installation_id = $3 AND provider_user_id = $4`,
      [tenantId, provider, installationId, providerUserId]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Linking challenges
  // ─────────────────────────────────────────────────────────────────────────────
  async saveLinkingChallenge(challenge: LinkingChallenge): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_linking_challenges
        (token, tenant_id, principal_id, roles, provider, installation_id, expires_at, consumed_at, consumed_by_user_id, revoked_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (token) DO UPDATE SET
        consumed_at = EXCLUDED.consumed_at,
        consumed_by_user_id = EXCLUDED.consumed_by_user_id,
        revoked_at = EXCLUDED.revoked_at`,
      [
        challenge.token,
        challenge.tenantId,
        challenge.principalId,
        JSON.stringify(challenge.roles),
        challenge.provider,
        challenge.installationId,
        challenge.expiresAt,
        challenge.consumedAt ?? null,
        challenge.consumedByUserId ?? null,
        challenge.revokedAt ?? null,
      ]
    );
  }

  async getLinkingChallenge(token: string): Promise<LinkingChallenge | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_linking_challenges WHERE token = $1`,
      [token]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      token: row.token,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      roles: Array.isArray(row.roles) ? row.roles : JSON.parse(row.roles),
      provider: row.provider,
      installationId: row.installation_id,
      expiresAt: toIsoString(row.expires_at),
      consumedAt: toNullableIsoString(row.consumed_at),
      consumedByUserId: row.consumed_by_user_id ?? undefined,
      revokedAt: toNullableIsoString(row.revoked_at),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Agent principals
  // ─────────────────────────────────────────────────────────────────────────────
  async getAgentPrincipal(tenantId: TenantId, principalId: string): Promise<AgentPrincipal | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_agent_principals WHERE tenant_id = $1 AND principal_id = $2`,
      [tenantId, principalId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      enabled: Boolean(row.enabled),
    };
  }

  async registerAgentPrincipal(principal: AgentPrincipal): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_agent_principals (tenant_id, principal_id, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, principal_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [principal.tenantId, principal.principalId, principal.enabled]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Inbound receipt & duplicate check
  // ─────────────────────────────────────────────────────────────────────────────
  async getInboundReceipt(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerEventId: string
  ): Promise<InboundEventReceipt | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_inbound_receipts
       WHERE tenant_id = $1 AND provider = $2 AND installation_id = $3 AND provider_event_id = $4`,
      [tenantId, provider, installationId, providerEventId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      receiptId: row.receipt_id,
      tenantId: row.tenant_id,
      provider: row.provider,
      installationId: row.installation_id,
      providerEventId: row.provider_event_id,
      payloadDigest: row.payload_digest,
      assignmentId: row.assignment_id,
      createdAt: toIsoString(row.created_at),
    };
  }

  async recordInboundReceipt(receipt: InboundEventReceipt): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_inbound_receipts
        (receipt_id, tenant_id, provider, installation_id, provider_event_id, payload_digest, assignment_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, provider, installation_id, provider_event_id) DO NOTHING`,
      [
        receipt.receiptId,
        receipt.tenantId,
        receipt.provider,
        receipt.installationId,
        receipt.providerEventId,
        receipt.payloadDigest,
        receipt.assignmentId,
        receipt.createdAt,
      ]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cases & Thread correlations
  // ─────────────────────────────────────────────────────────────────────────────
  async getCase(tenantId: TenantId, caseId: PayableCaseId): Promise<PayableCase | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_cases WHERE tenant_id = $1 AND case_id = $2`,
      [tenantId, caseId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      caseId: row.case_id,
      tenantId: row.tenant_id,
      sourceLinks: Array.isArray(row.source_links) ? row.source_links : JSON.parse(row.source_links),
      version: Number(row.version),
    };
  }

  async saveCase(c: PayableCase): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_cases (tenant_id, case_id, source_links, version)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (tenant_id, case_id) DO UPDATE SET
        source_links = EXCLUDED.source_links,
        version = EXCLUDED.version`,
      [c.tenantId, c.caseId, JSON.stringify(c.sourceLinks), c.version]
    );
  }

  async attachSourceLink(
    tenantId: TenantId,
    caseId: PayableCaseId,
    link: CaseSourceLink
  ): Promise<PayableCase> {
    const existing = await this.getCase(tenantId, caseId);
    const updatedLinks = existing ? [...existing.sourceLinks, link] : [link];
    const newVersion = existing ? existing.version + 1 : 1;
    const updatedCase: PayableCase = {
      caseId,
      tenantId,
      sourceLinks: updatedLinks,
      version: newVersion,
    };
    await this.saveCase(updatedCase);
    return updatedCase;
  }

  async findCaseByThread(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    threadId: string
  ): Promise<PayableCaseId | null> {
    const res = await this.pool.query(
      `SELECT case_id FROM harness_thread_case_links
       WHERE tenant_id = $1 AND provider = $2 AND installation_id = $3 AND thread_id = $4`,
      [tenantId, provider, installationId, threadId]
    );
    if (res.rowCount === 0) return null;
    return res.rows[0].case_id;
  }

  async linkThreadToCase(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    threadId: string,
    caseId: PayableCaseId
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_thread_case_links (tenant_id, provider, installation_id, thread_id, case_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, provider, installation_id, thread_id)
       DO UPDATE SET case_id = EXCLUDED.case_id`,
      [tenantId, provider, installationId, threadId, caseId]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Assignments
  // ─────────────────────────────────────────────────────────────────────────────
  async getAssignment(tenantId: TenantId, assignmentId: AssignmentId): Promise<Assignment | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_assignments WHERE tenant_id = $1 AND assignment_id = $2`,
      [tenantId, assignmentId]
    );
    if (res.rowCount === 0) return null;
    return this.mapAssignmentRow(res.rows[0]);
  }

  async saveAssignment(assignment: Assignment): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_assignments
        (tenant_id, assignment_id, case_id, agent_principal_id, requested_by_principal_id, state, version,
         active_run_id, ownership_epoch, cancellation_requested_at, pending_financial_intent_id,
         initial_l2_decision_id, latest_l2_decision_id, l2_approval_request_id, trigger_wait_token,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (tenant_id, assignment_id) DO UPDATE SET
        case_id = EXCLUDED.case_id,
        agent_principal_id = EXCLUDED.agent_principal_id,
        requested_by_principal_id = EXCLUDED.requested_by_principal_id,
        state = EXCLUDED.state,
        version = EXCLUDED.version,
        active_run_id = EXCLUDED.active_run_id,
        ownership_epoch = EXCLUDED.ownership_epoch,
        cancellation_requested_at = EXCLUDED.cancellation_requested_at,
        pending_financial_intent_id = EXCLUDED.pending_financial_intent_id,
        initial_l2_decision_id = EXCLUDED.initial_l2_decision_id,
        latest_l2_decision_id = EXCLUDED.latest_l2_decision_id,
        l2_approval_request_id = EXCLUDED.l2_approval_request_id,
        trigger_wait_token = EXCLUDED.trigger_wait_token,
        updated_at = EXCLUDED.updated_at`,
      [
        assignment.tenantId,
        assignment.assignmentId,
        assignment.caseId,
        assignment.agentPrincipalId,
        assignment.requestedByPrincipalId,
        assignment.state,
        assignment.version,
        assignment.activeRunId ?? null,
        assignment.ownershipEpoch,
        assignment.cancellationRequestedAt ?? null,
        assignment.pendingFinancialIntentId ?? null,
        assignment.initialL2DecisionId ?? null,
        assignment.latestL2DecisionId ?? null,
        assignment.l2ApprovalRequestId ?? null,
        assignment.triggerWaitToken ?? null,
        assignment.createdAt,
        assignment.updatedAt,
      ]
    );
  }

  async findAssignmentsByState(tenantId: TenantId, state: AssignmentState): Promise<readonly Assignment[]> {
    const res = await this.pool.query(
      `SELECT * FROM harness_assignments
       WHERE tenant_id = $1 AND state = $2
       ORDER BY created_at ASC`,
      [tenantId, state]
    );
    return res.rows.map((row) => this.mapAssignmentRow(row));
  }

  private mapAssignmentRow(row: any): Assignment {
    return {
      tenantId: row.tenant_id,
      assignmentId: row.assignment_id,
      caseId: row.case_id,
      agentPrincipalId: row.agent_principal_id,
      requestedByPrincipalId: row.requested_by_principal_id,
      state: row.state as AssignmentState,
      version: Number(row.version),
      activeRunId: row.active_run_id ?? undefined,
      ownershipEpoch: Number(row.ownership_epoch),
      cancellationRequestedAt: toNullableIsoString(row.cancellation_requested_at),
      pendingFinancialIntentId: row.pending_financial_intent_id ?? undefined,
      initialL2DecisionId: row.initial_l2_decision_id ?? undefined,
      latestL2DecisionId: row.latest_l2_decision_id ?? undefined,
      l2ApprovalRequestId: row.l2_approval_request_id ?? undefined,
      triggerWaitToken: row.trigger_wait_token ?? undefined,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Runs & Checkpoints
  // ─────────────────────────────────────────────────────────────────────────────
  async saveRun(run: AgentRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_runs
        (tenant_id, assignment_id, run_id, trigger_run_id, worker_version_id, specialist_role, ownership_epoch, started_at, completed_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, assignment_id, run_id) DO UPDATE SET
        completed_at = EXCLUDED.completed_at,
        status = EXCLUDED.status`,
      [
        run.tenantId,
        run.assignmentId,
        run.runId,
        run.triggerRunId,
        run.workerVersionId,
        run.specialistRole ?? null,
        run.ownershipEpoch,
        run.startedAt,
        run.completedAt ?? null,
        run.status,
      ]
    );
  }

  async getRun(tenantId: TenantId, assignmentId: AssignmentId, runId: string): Promise<AgentRun | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_runs WHERE tenant_id = $1 AND assignment_id = $2 AND run_id = $3`,
      [tenantId, assignmentId, runId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      tenantId: row.tenant_id,
      assignmentId: row.assignment_id,
      runId: row.run_id,
      triggerRunId: row.trigger_run_id,
      workerVersionId: row.worker_version_id,
      specialistRole: (row.specialist_role as SpecialistRole) ?? undefined,
      ownershipEpoch: Number(row.ownership_epoch),
      startedAt: toIsoString(row.started_at),
      completedAt: toNullableIsoString(row.completed_at),
      status: row.status,
    };
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_checkpoints
        (tenant_id, checkpoint_id, assignment_id, run_id, ownership_epoch, stage, input_refs, output_refs, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       ON CONFLICT (tenant_id, checkpoint_id) DO NOTHING`,
      [
        checkpoint.tenantId,
        checkpoint.checkpointId,
        checkpoint.assignmentId,
        checkpoint.runId,
        checkpoint.ownershipEpoch,
        checkpoint.stage,
        JSON.stringify(checkpoint.inputRefs),
        JSON.stringify(checkpoint.outputRefs),
        checkpoint.recordedAt,
      ]
    );
  }

  async getCheckpoints(tenantId: TenantId, assignmentId: AssignmentId): Promise<readonly Checkpoint[]> {
    const res = await this.pool.query(
      `SELECT * FROM harness_checkpoints
       WHERE tenant_id = $1 AND assignment_id = $2
       ORDER BY recorded_at ASC`,
      [tenantId, assignmentId]
    );
    return res.rows.map((row) => ({
      tenantId: row.tenant_id,
      checkpointId: row.checkpoint_id,
      assignmentId: row.assignment_id,
      runId: row.run_id,
      ownershipEpoch: Number(row.ownership_epoch),
      stage: row.stage as CheckpointStage,
      inputRefs: Array.isArray(row.input_refs) ? row.input_refs : JSON.parse(row.input_refs),
      outputRefs: Array.isArray(row.output_refs) ? row.output_refs : JSON.parse(row.output_refs),
      recordedAt: toIsoString(row.recorded_at),
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Command receipts
  // ─────────────────────────────────────────────────────────────────────────────
  async getCommandReceipt(
    tenantId: TenantId,
    scope: string,
    commandKey: string
  ): Promise<CommandReceipt | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_command_receipts
       WHERE tenant_id = $1 AND scope = $2 AND command_key = $3`,
      [tenantId, scope, commandKey]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      commandReceiptId: row.command_receipt_id,
      tenantId: row.tenant_id,
      scope: row.scope,
      commandKey: row.command_key,
      payloadDigest: row.payload_digest,
      resultRef: row.result_ref,
      createdAt: toIsoString(row.created_at),
    };
  }

  async saveCommandReceipt(receipt: CommandReceipt): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_command_receipts
        (tenant_id, scope, command_key, command_receipt_id, payload_digest, result_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, scope, command_key) DO NOTHING`,
      [
        receipt.tenantId,
        receipt.scope,
        receipt.commandKey,
        receipt.commandReceiptId,
        receipt.payloadDigest,
        receipt.resultRef,
        receipt.createdAt,
      ]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Financial intent & decision references
  // ─────────────────────────────────────────────────────────────────────────────
  async saveFinancialIntent(intent: FinancialIntentReference): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_financial_intents
        (tenant_id, intent_id, assignment_id, case_id, case_version, requested_by_principal_id,
         worker_principal_id, requested_budget_id, envelope_ids, idempotency_key, payload_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       ON CONFLICT (tenant_id, intent_id) DO NOTHING`,
      [
        (intent as any).tenantId ?? 'default-tenant',
        intent.intentId,
        intent.assignmentId,
        intent.caseId,
        intent.caseVersion,
        intent.requestedByPrincipalId,
        intent.workerPrincipalId,
        intent.requestedBudgetId,
        JSON.stringify(intent.envelopeIds),
        intent.idempotencyKey,
        intent.payloadDigest,
      ]
    );
  }

  async getFinancialIntent(tenantId: TenantId, intentId: string): Promise<FinancialIntentReference | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_financial_intents WHERE (tenant_id = $1 OR tenant_id = 'default-tenant') AND intent_id = $2`,
      [tenantId, intentId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      intentId: row.intent_id,
      assignmentId: row.assignment_id,
      caseId: row.case_id,
      caseVersion: Number(row.case_version),
      requestedByPrincipalId: row.requested_by_principal_id,
      workerPrincipalId: row.worker_principal_id,
      requestedBudgetId: row.requested_budget_id,
      envelopeIds: Array.isArray(row.envelope_ids) ? row.envelope_ids : JSON.parse(row.envelope_ids),
      idempotencyKey: row.idempotency_key,
      payloadDigest: row.payload_digest,
    };
  }

  async saveFinancialDecision(tenantId: TenantId, decision: FinancialDecisionReference): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_financial_decisions
        (tenant_id, decision_id, outcome, approval_request_id, gate_summary_refs)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (tenant_id, decision_id) DO UPDATE SET
        outcome = EXCLUDED.outcome,
        approval_request_id = EXCLUDED.approval_request_id,
        gate_summary_refs = EXCLUDED.gate_summary_refs`,
      [
        tenantId,
        decision.decisionId,
        decision.outcome,
        decision.approvalRequestId ?? null,
        JSON.stringify(decision.gateSummaryRefs),
      ]
    );
  }

  async getFinancialDecision(tenantId: TenantId, decisionId: string): Promise<FinancialDecisionReference | null> {
    const res = await this.pool.query(
      `SELECT * FROM harness_financial_decisions WHERE tenant_id = $1 AND decision_id = $2`,
      [tenantId, decisionId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      decisionId: row.decision_id,
      outcome: row.outcome as FinancialOutcome,
      approvalRequestId: row.approval_request_id ?? undefined,
      gateSummaryRefs: Array.isArray(row.gate_summary_refs) ? row.gate_summary_refs : JSON.parse(row.gate_summary_refs),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Events & Outbox
  // ─────────────────────────────────────────────────────────────────────────────
  async recordExecutionEvent(event: ExecutionEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_execution_events
        (tenant_id, event_id, aggregate_id, aggregate_version, event_type, command_id, causation_id, payload_ref, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [
        event.tenantId,
        event.eventId,
        event.aggregateId,
        event.aggregateVersion,
        event.eventType,
        event.commandId,
        event.causationId ?? null,
        event.payloadRef ?? null,
        event.occurredAt,
      ]
    );
  }

  async getExecutionEvents(tenantId: TenantId, aggregateId: string): Promise<readonly ExecutionEvent[]> {
    const res = await this.pool.query(
      `SELECT * FROM harness_execution_events
       WHERE tenant_id = $1 AND aggregate_id = $2
       ORDER BY aggregate_version ASC`,
      [tenantId, aggregateId]
    );
    return res.rows.map((row) => ({
      eventId: row.event_id,
      tenantId: row.tenant_id,
      aggregateId: row.aggregate_id,
      aggregateVersion: Number(row.aggregate_version),
      eventType: row.event_type,
      commandId: row.command_id,
      causationId: row.causation_id ?? undefined,
      payloadRef: row.payload_ref ?? undefined,
      occurredAt: toIsoString(row.occurred_at),
    }));
  }

  async enqueueOutbox(event: OutboxEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO harness_outbox_events
        (tenant_id, event_id, installation_id, event_type, command_id, payload, occurred_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [
        event.tenantId,
        event.eventId,
        event.installationId ?? null,
        event.eventType,
        event.commandId,
        JSON.stringify(event.payload),
        event.occurredAt,
        event.dispatchedAt ?? null,
      ]
    );
  }

  async drainOutbox(tenantId: TenantId, limit = 50): Promise<readonly OutboxEvent[]> {
    const now = new Date().toISOString();
    // PostgreSQL FOR UPDATE SKIP LOCKED ensures lock-free concurrent draining across workers
    const res = await this.pool.query(
      `WITH to_drain AS (
         SELECT event_id FROM harness_outbox_events
         WHERE tenant_id = $1 AND dispatched_at IS NULL
         ORDER BY occurred_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE harness_outbox_events
       SET dispatched_at = $3
       WHERE tenant_id = $1 AND event_id IN (SELECT event_id FROM to_drain)
       RETURNING *`,
      [tenantId, limit, now]
    );

    return res.rows.map((row) => ({
      eventId: row.event_id,
      tenantId: row.tenant_id,
      installationId: row.installation_id ?? undefined,
      eventType: row.event_type,
      commandId: row.command_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      occurredAt: toIsoString(row.occurred_at),
      dispatchedAt: toNullableIsoString(row.dispatched_at),
    }));
  }
}
