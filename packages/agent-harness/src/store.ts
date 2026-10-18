import type {
  AgentPrincipal,
  AgentRun,
  Assignment,
  AssignmentId,
  AssignmentState,
  Checkpoint,
  CommandReceipt,
  ExecutionEvent,
  ExternalPrincipalBinding,
  FinancialDecisionReference,
  FinancialIntentReference,
  InboundEventReceipt,
  LinkingChallenge,
  OutboxEvent,
  PayableCase,
  PayableCaseId,
  CaseSourceLink,
  TenantId,
} from './types.js';
import { HarnessError } from './state-machine.js';

export interface HarnessStore {
  // Principal bindings
  getPrincipalBinding(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<ExternalPrincipalBinding | null>;

  findPrincipalBindingsByUser(
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<readonly ExternalPrincipalBinding[]>;

  registerPrincipalBinding(binding: ExternalPrincipalBinding): Promise<void>;

  revokePrincipalBinding(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<void>;

  // Linking challenges
  saveLinkingChallenge(challenge: LinkingChallenge): Promise<void>;
  getLinkingChallenge(token: string): Promise<LinkingChallenge | null>;

  // Agent principals
  getAgentPrincipal(tenantId: TenantId, principalId: string): Promise<AgentPrincipal | null>;
  registerAgentPrincipal(principal: AgentPrincipal): Promise<void>;

  // Inbound receipt & duplicate check
  getInboundReceipt(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerEventId: string
  ): Promise<InboundEventReceipt | null>;

  recordInboundReceipt(receipt: InboundEventReceipt): Promise<void>;

  // Cases & Thread correlations
  getCase(tenantId: TenantId, caseId: PayableCaseId): Promise<PayableCase | null>;
  saveCase(c: PayableCase): Promise<void>;
  attachSourceLink(tenantId: TenantId, caseId: PayableCaseId, link: CaseSourceLink): Promise<PayableCase>;
  findCaseByThread(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    threadId: string
  ): Promise<PayableCaseId | null>;
  linkThreadToCase(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    threadId: string,
    caseId: PayableCaseId
  ): Promise<void>;

  // Assignments
  getAssignment(tenantId: TenantId, assignmentId: AssignmentId): Promise<Assignment | null>;
  saveAssignment(assignment: Assignment): Promise<void>;
  findAssignmentsByState(tenantId: TenantId, state: AssignmentState): Promise<readonly Assignment[]>;

  // Runs & Checkpoints
  saveRun(run: AgentRun): Promise<void>;
  getRun(tenantId: TenantId, assignmentId: AssignmentId, runId: string): Promise<AgentRun | null>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoints(tenantId: TenantId, assignmentId: AssignmentId): Promise<readonly Checkpoint[]>;

  // Command receipts
  getCommandReceipt(
    tenantId: TenantId,
    scope: string,
    commandKey: string
  ): Promise<CommandReceipt | null>;
  saveCommandReceipt(receipt: CommandReceipt): Promise<void>;

  // Financial intent & decision references
  saveFinancialIntent(intent: FinancialIntentReference): Promise<void>;
  getFinancialIntent(tenantId: TenantId, intentId: string): Promise<FinancialIntentReference | null>;
  saveFinancialDecision(tenantId: TenantId, decision: FinancialDecisionReference): Promise<void>;
  getFinancialDecision(tenantId: TenantId, decisionId: string): Promise<FinancialDecisionReference | null>;

  // Events & Outbox
  recordExecutionEvent(event: ExecutionEvent): Promise<void>;
  getExecutionEvents(tenantId: TenantId, aggregateId: string): Promise<readonly ExecutionEvent[]>;
  enqueueOutbox(event: OutboxEvent): Promise<void>;
  drainOutbox(tenantId: TenantId, limit?: number): Promise<readonly OutboxEvent[]>;
}

export class InMemoryHarnessStore implements HarnessStore {
  public readonly principalBindings = new Map<string, ExternalPrincipalBinding>();
  public readonly agentPrincipals = new Map<string, AgentPrincipal>();
  public readonly inboundReceipts = new Map<string, InboundEventReceipt>();
  public readonly cases = new Map<string, PayableCase>();
  public readonly threadCaseLinks = new Map<string, PayableCaseId>();
  public readonly assignments = new Map<string, Assignment>();
  public readonly runs = new Map<string, AgentRun>();
  public readonly checkpoints = new Map<string, Checkpoint>();
  public readonly commandReceipts = new Map<string, CommandReceipt>();
  public readonly financialIntents = new Map<string, FinancialIntentReference>();
  public readonly financialDecisions = new Map<string, FinancialDecisionReference>();
  public readonly executionEvents: ExecutionEvent[] = [];
  public readonly outboxEvents: OutboxEvent[] = [];
  public readonly linkingChallenges = new Map<string, LinkingChallenge>();

  private inboundKey(tenant: string, prov: string, inst: string, evt: string): string {
    return `${tenant}:${prov}:${inst}:${evt}`;
  }

  private threadKey(tenant: string, prov: string, inst: string, thread: string): string {
    return `${tenant}:${prov}:${inst}:${thread}`;
  }

  private bindingKey(tenant: string, prov: string, inst: string, user: string): string {
    return `${tenant}:${prov}:${inst}:${user}`;
  }

  private assignmentKey(tenant: string, id: string): string {
    return `${tenant}:${id}`;
  }

  private caseKey(tenant: string, id: string): string {
    return `${tenant}:${id}`;
  }

  private commandKey(tenant: string, scope: string, key: string): string {
    return `${tenant}:${scope}:${key}`;
  }

  async getPrincipalBinding(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<ExternalPrincipalBinding | null> {
    const key = this.bindingKey(tenantId, provider, installationId, providerUserId);
    return this.principalBindings.get(key) ?? null;
  }

  async findPrincipalBindingsByUser(
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<readonly ExternalPrincipalBinding[]> {
    const matches: ExternalPrincipalBinding[] = [];
    for (const b of this.principalBindings.values()) {
      if (
        b.provider === provider &&
        b.installationId === installationId &&
        b.providerUserId === providerUserId
      ) {
        matches.push({ ...b });
      }
    }
    return matches;
  }

  async registerPrincipalBinding(binding: ExternalPrincipalBinding): Promise<void> {
    const key = this.bindingKey(
      binding.tenantId,
      binding.provider,
      binding.installationId,
      binding.providerUserId
    );
    this.principalBindings.set(key, { ...binding });
  }

  async revokePrincipalBinding(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerUserId: string
  ): Promise<void> {
    const key = this.bindingKey(tenantId, provider, installationId, providerUserId);
    const existing = this.principalBindings.get(key);
    if (existing) {
      existing.revoked = true;
    }
  }

  async saveLinkingChallenge(challenge: LinkingChallenge): Promise<void> {
    this.linkingChallenges.set(challenge.token, {
      ...challenge,
      roles: [...challenge.roles],
    });
  }

  async getLinkingChallenge(token: string): Promise<LinkingChallenge | null> {
    const ch = this.linkingChallenges.get(token);
    if (!ch) return null;
    return { ...ch, roles: [...ch.roles] };
  }

  async getAgentPrincipal(tenantId: TenantId, principalId: string): Promise<AgentPrincipal | null> {
    return this.agentPrincipals.get(`${tenantId}:${principalId}`) ?? null;
  }

  async registerAgentPrincipal(principal: AgentPrincipal): Promise<void> {
    this.agentPrincipals.set(`${principal.tenantId}:${principal.principalId}`, { ...principal });
  }

  async getInboundReceipt(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    providerEventId: string
  ): Promise<InboundEventReceipt | null> {
    const key = this.inboundKey(tenantId, provider, installationId, providerEventId);
    return this.inboundReceipts.get(key) ?? null;
  }

  async recordInboundReceipt(receipt: InboundEventReceipt): Promise<void> {
    const key = this.inboundKey(
      receipt.tenantId,
      receipt.provider,
      receipt.installationId,
      receipt.providerEventId
    );
    const existing = this.inboundReceipts.get(key);
    if (existing) {
      if (existing.payloadDigest !== receipt.payloadDigest) {
        throw new HarnessError(
          'CONFLICTING_EVENT_PAYLOAD',
          `Conflicting payload digest under existing inbound event ${receipt.providerEventId}`
        );
      }
      return;
    }
    this.inboundReceipts.set(key, { ...receipt });
  }

  async getCase(tenantId: TenantId, caseId: PayableCaseId): Promise<PayableCase | null> {
    return this.cases.get(this.caseKey(tenantId, caseId)) ?? null;
  }

  async saveCase(c: PayableCase): Promise<void> {
    this.cases.set(this.caseKey(c.tenantId, c.caseId), {
      ...c,
      sourceLinks: [...c.sourceLinks],
    });
  }

  async attachSourceLink(
    tenantId: TenantId,
    caseId: PayableCaseId,
    link: CaseSourceLink
  ): Promise<PayableCase> {
    const existing = await this.getCase(tenantId, caseId);
    const updated: PayableCase = existing
      ? {
          ...existing,
          version: existing.version + 1,
          sourceLinks: [...existing.sourceLinks, link],
        }
      : {
          caseId,
          tenantId,
          version: 1,
          sourceLinks: [link],
        };
    await this.saveCase(updated);
    return updated;
  }

  async findCaseByThread(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    threadId: string
  ): Promise<PayableCaseId | null> {
    return this.threadCaseLinks.get(this.threadKey(tenantId, provider, installationId, threadId)) ?? null;
  }

  async linkThreadToCase(
    tenantId: TenantId,
    provider: string,
    installationId: string,
    threadId: string,
    caseId: PayableCaseId
  ): Promise<void> {
    this.threadCaseLinks.set(this.threadKey(tenantId, provider, installationId, threadId), caseId);
  }

  async getAssignment(tenantId: TenantId, assignmentId: AssignmentId): Promise<Assignment | null> {
    const a = this.assignments.get(this.assignmentKey(tenantId, assignmentId));
    return a ? { ...a } : null;
  }

  async saveAssignment(assignment: Assignment): Promise<void> {
    this.assignments.set(this.assignmentKey(assignment.tenantId, assignment.assignmentId), {
      ...assignment,
    });
  }

  async findAssignmentsByState(
    tenantId: TenantId,
    state: AssignmentState
  ): Promise<readonly Assignment[]> {
    const results: Assignment[] = [];
    for (const a of this.assignments.values()) {
      if (a.tenantId === tenantId && a.state === state) {
        results.push({ ...a });
      }
    }
    return results;
  }

  async saveRun(run: AgentRun): Promise<void> {
    this.runs.set(`${run.tenantId}:${run.assignmentId}:${run.runId}`, { ...run });
  }

  async getRun(tenantId: TenantId, assignmentId: AssignmentId, runId: string): Promise<AgentRun | null> {
    return this.runs.get(`${tenantId}:${assignmentId}:${runId}`) ?? null;
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(
      `${checkpoint.tenantId}:${checkpoint.assignmentId}:${checkpoint.checkpointId}`,
      { ...checkpoint, inputRefs: [...checkpoint.inputRefs], outputRefs: [...checkpoint.outputRefs] }
    );
  }

  async getCheckpoints(tenantId: TenantId, assignmentId: AssignmentId): Promise<readonly Checkpoint[]> {
    const prefix = `${tenantId}:${assignmentId}:`;
    const results: Checkpoint[] = [];
    for (const [k, v] of this.checkpoints) {
      if (k.startsWith(prefix)) {
        results.push({ ...v });
      }
    }
    return results.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  async getCommandReceipt(
    tenantId: TenantId,
    scope: string,
    commandKey: string
  ): Promise<CommandReceipt | null> {
    const key = this.commandKey(tenantId, scope, commandKey);
    return this.commandReceipts.get(key) ?? null;
  }

  async saveCommandReceipt(receipt: CommandReceipt): Promise<void> {
    const key = this.commandKey(receipt.tenantId, receipt.scope, receipt.commandKey);
    const existing = this.commandReceipts.get(key);
    if (existing) {
      if (existing.payloadDigest !== receipt.payloadDigest) {
        throw new HarnessError(
          'COMMAND_RECEIPT_CONFLICT',
          `Command receipt conflict: key ${receipt.commandKey} already exists with different payload digest`
        );
      }
      return;
    }
    this.commandReceipts.set(key, { ...receipt });
  }

  async saveFinancialIntent(intent: FinancialIntentReference): Promise<void> {
    this.financialIntents.set(intent.intentId, { ...intent, envelopeIds: [...intent.envelopeIds] });
  }

  async getFinancialIntent(_tenantId: TenantId, intentId: string): Promise<FinancialIntentReference | null> {
    const intent = this.financialIntents.get(intentId);
    if (!intent) return null;
    return { ...intent, envelopeIds: [...intent.envelopeIds] };
  }

  async saveFinancialDecision(tenantId: TenantId, decision: FinancialDecisionReference): Promise<void> {
    this.financialDecisions.set(`${tenantId}:${decision.decisionId}`, {
      ...decision,
      gateSummaryRefs: [...decision.gateSummaryRefs],
    });
  }

  async getFinancialDecision(tenantId: TenantId, decisionId: string): Promise<FinancialDecisionReference | null> {
    const decision = this.financialDecisions.get(`${tenantId}:${decisionId}`);
    if (!decision) return null;
    return { ...decision, gateSummaryRefs: [...decision.gateSummaryRefs] };
  }

  async recordExecutionEvent(event: ExecutionEvent): Promise<void> {
    this.executionEvents.push({ ...event });
  }

  async getExecutionEvents(tenantId: TenantId, aggregateId: string): Promise<readonly ExecutionEvent[]> {
    return this.executionEvents
      .filter((e) => e.tenantId === tenantId && e.aggregateId === aggregateId)
      .sort((a, b) => a.aggregateVersion - b.aggregateVersion);
  }

  async enqueueOutbox(event: OutboxEvent): Promise<void> {
    this.outboxEvents.push({ ...event });
  }

  async drainOutbox(tenantId: TenantId, limit = 50): Promise<readonly OutboxEvent[]> {
    const now = new Date().toISOString();
    const drained: OutboxEvent[] = [];
    for (const evt of this.outboxEvents) {
      if (evt.tenantId === tenantId && !evt.dispatchedAt) {
        evt.dispatchedAt = now;
        drained.push({ ...evt });
        if (drained.length >= limit) break;
      }
    }
    return drained;
  }
}
