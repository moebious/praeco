import type { IntakeChannel, ReadyEvidence } from '@praeco/evidence-intelligence';
import type { FinancialEvaluation } from '@praeco/financial-decision-kernel';

export type TenantId = string;
export type AssignmentId = string;
export type PayableCaseId = string;
export type L1EnvelopeId = string;
export type L2DecisionId = string;
export type SpecialistRole = 'VERA' | 'KAEL' | 'NOVA';
export type FinancialOutcome = 'AUTHORIZED_SIMULATED' | 'BLOCKED' | 'PENDING_HUMAN_APPROVAL';

export type AssignmentState =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_FOR_REVIEW'
  | 'COMPLETED'
  | 'FAILED_RECOVERABLE'
  | 'FAILED_TERMINAL'
  | 'CANCELLED';

export interface TrustedPrincipal {
  tenantId: TenantId;
  principalId: string;
  roles: readonly string[];
  bindingRevision: string;
}

export interface ChannelScope {
  provider: 'WEB' | 'EMAIL' | 'TELEGRAM' | 'SLACK' | 'WHATSAPP';
  installationId: string;
}

export interface InboundMessageCommand extends ChannelScope {
  providerEventId: string;
  providerUserId: string;
  providerThreadId: string;
  messageId: string;
  payloadDigest: string;
  text?: string;
  attachmentRefs: readonly string[];
}

export interface AgentPrincipal {
  tenantId: TenantId;
  principalId: string;
  enabled: boolean;
}

export interface TrustedExecutionContext {
  principal: TrustedPrincipal;
  assignmentId: AssignmentId;
  workerPrincipalId: string;
  workerVersionId: string;
  runId: string;
  ownershipEpoch: number;
}

export type EvidenceRunReference = {
  sourceId: string;
  sourceHashSha256: string;
  pipelineRunId: string;
  externalBindingId?: string;
} & (
  | { sourceDisposition: 'SUPPLEMENTAL_CONTEXT'; envelopeIds: readonly [] }
  | { sourceDisposition: 'INVOICE_OR_UNCERTAIN'; envelopeIds: readonly [L1EnvelopeId, ...L1EnvelopeId[]] }
);

export type CaseSourceLink =
  | { kind: 'DOCUMENT'; evidence: EvidenceRunReference }
  | { kind: 'ERP_REFERENCE' | 'CHANNEL_MESSAGE'; refId: string };

export interface PayableCase {
  caseId: PayableCaseId;
  tenantId: TenantId;
  sourceLinks: readonly CaseSourceLink[];
  version: number;
}

export interface Assignment {
  assignmentId: AssignmentId;
  tenantId: TenantId;
  caseId: PayableCaseId;
  agentPrincipalId: string;
  requestedByPrincipalId: string;
  state: AssignmentState;
  version: number;
  activeRunId?: string;
  ownershipEpoch: number;
  cancellationRequestedAt?: string;
  pendingFinancialIntentId?: string;
  initialL2DecisionId?: L2DecisionId;
  latestL2DecisionId?: L2DecisionId;
  l2ApprovalRequestId?: string;
  triggerWaitToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  tenantId: TenantId;
  assignmentId: AssignmentId;
  runId: string;
  triggerRunId: string;
  workerVersionId: string;
  specialistRole?: SpecialistRole;
  ownershipEpoch: number;
  startedAt: string;
  completedAt?: string;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
}

export type CheckpointStage =
  | 'INGESTED'
  | 'EVIDENCE_RESOLVED'
  | 'L2_INTENT_RECORDED'
  | 'L2_DECISION_RECORDED'
  | 'AWAITING_REVIEW'
  | 'FINISHED';

export interface Checkpoint {
  tenantId: TenantId;
  checkpointId: string;
  assignmentId: AssignmentId;
  runId: string;
  ownershipEpoch: number;
  stage: CheckpointStage;
  inputRefs: readonly string[];
  outputRefs: readonly string[];
  recordedAt: string;
}

export interface ExecutionEvent {
  eventId: string;
  tenantId: TenantId;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  commandId: string;
  causationId?: string;
  payloadRef?: string;
  occurredAt: string;
}

export interface FinancialIntentReference {
  tenantId: TenantId;
  intentId: string;
  assignmentId: AssignmentId;
  caseId: PayableCaseId;
  caseVersion: number;
  requestedByPrincipalId: string;
  workerPrincipalId: string;
  requestedBudgetId: string;
  envelopeIds: readonly [L1EnvelopeId, ...L1EnvelopeId[]];
  idempotencyKey: string;
  payloadDigest: string;
}

export interface FinancialDecisionReference {
  decisionId: L2DecisionId;
  outcome: FinancialOutcome;
  approvalRequestId?: string;
  gateSummaryRefs: readonly string[];
}

export type FinancialCommandObservation =
  | { status: 'NOT_FOUND' | 'IN_PROGRESS' }
  | { status: 'COMPLETED'; decision: FinancialDecisionReference };

export type ApprovalObservation =
  | { status: 'PENDING'; expiresAt: string }
  | { status: 'RESOLVED'; resolutionDecisionId: L2DecisionId }
  | { status: 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'STALE'; resolutionDecisionId?: L2DecisionId };

export interface OutboxEvent {
  eventId: string;
  tenantId: TenantId;
  installationId?: string;
  eventType: string;
  commandId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  dispatchedAt?: string;
}

export interface InboundEventReceipt {
  receiptId: string;
  tenantId: TenantId;
  provider: InboundMessageCommand['provider'];
  installationId: string;
  providerEventId: string;
  payloadDigest: string;
  assignmentId: AssignmentId;
  createdAt: string;
}

export interface CommandReceipt {
  commandReceiptId: string;
  tenantId: TenantId;
  scope: string;
  commandKey: string;
  payloadDigest: string;
  resultRef: string;
  createdAt: string;
}

export interface ExternalPrincipalBinding {
  tenantId: TenantId;
  provider: InboundMessageCommand['provider'];
  installationId: string;
  providerUserId: string;
  principalId: string;
  roles: readonly string[];
  bindingRevision: string;
  revoked: boolean;
}

export interface LinkingChallenge {
  token: string;
  tenantId: TenantId;
  principalId: string;
  roles: readonly string[];
  provider: InboundMessageCommand['provider'];
  installationId: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByUserId?: string;
  revokedAt?: string;
}

export interface AssignmentPort {
  createOrLoad(
    input: InboundMessageCommand,
    principal: TrustedPrincipal
  ): Promise<{ assignment: Assignment; isDuplicate: boolean }>;

  claimRun(
    input: {
      assignmentId: AssignmentId;
      triggerRunId: string;
      workerVersionId: string;
      specialistRole?: SpecialistRole;
    },
    principal: TrustedPrincipal
  ): Promise<TrustedExecutionContext>;

  advance(
    input: {
      assignmentId: AssignmentId;
      expectedVersion: number;
      next: AssignmentState;
      outputRefs: readonly string[];
      checkpointStage?: CheckpointStage;
    },
    context: TrustedExecutionContext
  ): Promise<Assignment>;

  get(assignmentId: AssignmentId, principal: TrustedPrincipal): Promise<Assignment>;
}

export interface EvidencePort {
  ingestSource(
    params: {
      bytes: Uint8Array;
      channel: IntakeChannel;
      mimeType: string;
      displayName?: string;
      originMessageId?: string;
    },
    context: TrustedExecutionContext
  ): Promise<EvidenceRunReference>;

  loadRun(
    reference: EvidenceRunReference,
    principal: TrustedPrincipal
  ): Promise<EvidenceRunReference>;

  loadReady(
    envelopeId: L1EnvelopeId,
    principal: TrustedPrincipal
  ): Promise<ReadyEvidence>;
}

export interface FinancialDecisionPort {
  preview(
    intent: FinancialIntentReference,
    context: TrustedExecutionContext,
    scenarioId?: string
  ): Promise<{ binding: false; resultRef: string; evaluation: FinancialEvaluation }>;

  decideAndCommit(
    intent: FinancialIntentReference,
    context: TrustedExecutionContext,
    scenarioId?: string
  ): Promise<FinancialDecisionReference>;

  getCommandResult(
    intent: FinancialIntentReference,
    context: TrustedExecutionContext,
    scenarioId?: string
  ): Promise<FinancialCommandObservation>;

  getDecision(
    decisionId: L2DecisionId,
    principal: TrustedPrincipal,
    scenarioId?: string
  ): Promise<FinancialDecisionReference | null>;

  getApprovalStatus(
    approvalRequestId: string,
    principal: TrustedPrincipal,
    scenarioId?: string
  ): Promise<ApprovalObservation | null>;

  resolveApproval(
    params: {
      approvalRequestId: string;
      action: 'APPROVE' | 'REJECT';
      reason?: string;
      idempotencyKey?: string;
    },
    principal: TrustedPrincipal,
    scenarioId?: string
  ): Promise<FinancialDecisionReference>;
}

export interface ReconcilerTickReport {
  tenantId: TenantId;
  drainedOutboxCount: number;
  observedApprovalsCount: number;
  completedAssignmentsCount: number;
  timestamp: string;
}
