import { randomUUID } from 'node:crypto';
import type {
  Assignment,
  AssignmentId,
  EvidencePort,
  FinancialDecisionPort,
  FinancialDecisionReference,
  FinancialOutcome,
  TrustedExecutionContext,
  TrustedPrincipal,
} from './types.js';
import { HarnessError } from './state-machine.js';
import type { HarnessStore } from './store.js';
import type { AssignmentService } from './service.js';
import { SpecialistToolRegistry } from './specialists/registry.js';
import { BoundedSpecialistRunner } from './specialists/runner.js';
import { createVeraTools } from './specialists/vera.js';
import { createKaelTools } from './specialists/kael.js';
import { createNovaTools } from './specialists/nova.js';
import { createEveTools, type ChannelInboxPort } from './specialists/eve.js';
import type {
  KaelPolicyExplanationView,
  NovaProposalDispatchResult,
  SpecialistLimits,
  VeraEvidenceView,
} from './specialists/types.js';

export interface WorkflowRunnerOptions {
  store: HarnessStore;
  service: AssignmentService;
  specialistLimits?: Partial<SpecialistLimits>;
  evidencePort?: EvidencePort;
  decisionPort?: FinancialDecisionPort;
  channelInbox?: ChannelInboxPort;
}

export interface WorkflowExecutionParams {
  assignmentId: AssignmentId;
  triggerRunId: string;
  sourceReference: string;
  requestedBudgetId: string;
  scenarioId?: string;
  /**
   * Explicit envelope binding for multi-invoice packets: when a single source
   * carries several verified invoice envelopes, each payable case must name
   * the envelope it belongs to. Defaults to the first ready envelope, which
   * remains correct for single-invoice sources.
   */
  envelopeId?: string;
}

export interface WorkflowExecutionResult {
  assignment: Assignment;
  outcome?: FinancialOutcome;
  decisionId?: string;
  approvalRequestId?: string;
  evidenceView: VeraEvidenceView;
  policyExplanation?: KaelPolicyExplanationView;
  proposalResult?: NovaProposalDispatchResult;
  isSupplementalOnly?: boolean;
}

export class WorkflowRunner {
  private readonly store: HarnessStore;
  private readonly service: AssignmentService;
  private readonly registry: SpecialistToolRegistry;
  private readonly runner: BoundedSpecialistRunner;
  private readonly decisionPort?: FinancialDecisionPort;

  constructor(options: WorkflowRunnerOptions) {
    this.store = options.store;
    this.service = options.service;
    this.decisionPort = options.decisionPort;
    this.registry = new SpecialistToolRegistry();

    // Register all specialist tools, wiring evidencePort and decisionPort if provided
    for (const tool of createVeraTools({
      store: this.store,
      evidencePort: options.evidencePort,
    })) {
      this.registry.registerTool(tool);
    }
    for (const tool of createKaelTools({
      store: this.store,
      decisionPort: options.decisionPort,
    })) {
      this.registry.registerTool(tool);
    }
    for (const tool of createNovaTools({
      store: this.store,
      decisionPort: options.decisionPort,
    })) {
      this.registry.registerTool(tool);
    }

    if (options.channelInbox) {
      for (const tool of createEveTools({
        store: this.store,
        service: this.service,
        inbox: options.channelInbox,
        evidencePort: options.evidencePort,
      })) {
        this.registry.registerTool(tool);
      }
    }

    this.runner = new BoundedSpecialistRunner(this.registry, options.specialistLimits);
  }

  getToolRegistry(): SpecialistToolRegistry {
    return this.registry;
  }

  /**
   * Executes the full durable assignment workflow.
   * Progression:
   * 1. Claims active run & monotonic epoch.
   * 2. Step 1 (Vera): inspects documentary evidence -> Checkpoint EVIDENCE_RESOLVED.
   *    - If supplemental-only: completes without minting financial intent or dispatching L2.
   * 3. Step 2 (Kael): runs read-only policy preview -> explains gates.
   * 4. Step 3 (Nova): freezes financial intent -> Checkpoint L2_INTENT_RECORDED.
   * 5. Step 4 (Nova): submits proposal to L2 -> Checkpoint L2_DECISION_RECORDED.
   * 6. Resolves outcome:
   *    - AUTHORIZED_SIMULATED / BLOCKED -> COMPLETED -> Checkpoint FINISHED.
   *    - PENDING_HUMAN_APPROVAL -> WAITING_FOR_REVIEW -> Checkpoint AWAITING_REVIEW.
   *
   * Safety invariant: Never mark simulated authorization as PAID.
   */
  async executeAssignmentWorkflow(
    params: WorkflowExecutionParams,
    principal: TrustedPrincipal
  ): Promise<WorkflowExecutionResult> {
    // 1. Claim active run & increment epoch
    const context = await this.service.claimRun(
      {
        assignmentId: params.assignmentId,
        triggerRunId: params.triggerRunId,
        workerVersionId: 'v1.0.0',
        specialistRole: 'VERA',
      },
      principal
    );

    let assignment = await this.service.get(params.assignmentId, principal);

    // 2. Step 1: Vera Documentary Inspection
    const veraContext: TrustedExecutionContext = {
      ...context,
      workerPrincipalId: `${context.workerPrincipalId}-vera`,
    };
    const veraRes = await this.runner.runSpecialistLoop(
      'VERA',
      [
        {
          toolName: 'inspect_evidence_run',
          params: { sourceReference: params.sourceReference },
        },
      ],
      veraContext
    );
    const evidenceView = veraRes.finalOutput as unknown as VeraEvidenceView;

    assignment = await this.service.advance(
      {
        assignmentId: params.assignmentId,
        expectedVersion: assignment.version,
        next: 'RUNNING',
        outputRefs: [evidenceView.sourceId],
        checkpointStage: 'EVIDENCE_RESOLVED',
      },
      context
    );

    // If documentary intake is supplemental context only (e.g. email context, notes),
    // it records context and NEVER creates a financial intent or submits to L2 (Contract Sec 5 / ADR-007).
    if (
      evidenceView.sourceDisposition === 'SUPPLEMENTAL_CONTEXT' ||
      evidenceView.envelopes.length === 0
    ) {
      assignment = await this.service.advance(
        {
          assignmentId: params.assignmentId,
          expectedVersion: assignment.version,
          next: 'COMPLETED',
          outputRefs: [evidenceView.sourceId],
          checkpointStage: 'FINISHED',
        },
        context
      );

      return {
        assignment,
        evidenceView,
        isSupplementalOnly: true,
      };
    }

    // 3. Step 2: Kael Policy Explanation (Read-Only Preview)
    // A payable case may bind explicitly to one envelope of a multi-invoice
    // packet; without a binding the first ready envelope is used.
    const envelopeId = params.envelopeId ?? evidenceView.envelopes[0]!.envelopeId;
    const kaelContext: TrustedExecutionContext = {
      ...context,
      workerPrincipalId: `${context.workerPrincipalId}-kael`,
    };
    const kaelRes = await this.runner.runSpecialistLoop(
      'KAEL',
      [
        {
          toolName: 'explain_policy_evaluation',
          params: {
            envelopeId,
            scenarioId: params.scenarioId,
          },
        },
      ],
      kaelContext
    );
    const policyExplanation = kaelRes.finalOutput as unknown as KaelPolicyExplanationView;

    // 4. Step 3: Nova Intent Preparation
    const novaContext: TrustedExecutionContext = {
      ...context,
      workerPrincipalId: `${context.workerPrincipalId}-nova`,
    };
    const novaIntentRes = await this.runner.runSpecialistLoop(
      'NOVA',
      [
        {
          toolName: 'prepare_financial_intent',
          params: {
            caseId: assignment.caseId,
            envelopeId,
            requestedBudgetId: params.requestedBudgetId,
            scenarioId: params.scenarioId,
          },
        },
      ],
      novaContext
    );
    const intentOutput = novaIntentRes.finalOutput as {
      intentId: string;
      idempotencyKey: string;
    };

    assignment = await this.service.advance(
      {
        assignmentId: params.assignmentId,
        expectedVersion: assignment.version,
        next: 'RUNNING',
        outputRefs: [intentOutput.intentId],
        checkpointStage: 'L2_INTENT_RECORDED',
      },
      context
    );

    // 5. Step 4: Nova Proposal Dispatch to L2
    const novaSubmitRes = await this.runner.runSpecialistLoop(
      'NOVA',
      [
        {
          toolName: 'submit_financial_proposal',
          params: {
            intentId: intentOutput.intentId,
            scenarioId: params.scenarioId,
          },
        },
      ],
      novaContext
    );
    const proposalResult = novaSubmitRes.finalOutput as unknown as NovaProposalDispatchResult;

    assignment = await this.service.advance(
      {
        assignmentId: params.assignmentId,
        expectedVersion: assignment.version,
        next: 'RUNNING',
        outputRefs: [proposalResult.decisionId],
        checkpointStage: 'L2_DECISION_RECORDED',
      },
      context
    );

    // 6. Outcome Resolution
    if (proposalResult.outcome === 'PENDING_HUMAN_APPROVAL') {
      // Resolve-before-subscribe pre-check (ADR-007 Exit Criteria #3 / Sec 5.4):
      // Check if approval was already resolved prior to waitpoint installation.
      let alreadyResolved = false;
      if (this.decisionPort && proposalResult.approvalRequestId) {
        const preObservation = await this.decisionPort.getApprovalStatus(
          proposalResult.approvalRequestId,
          principal,
          params.scenarioId
        );
        if (preObservation && preObservation.status !== 'PENDING') {
          alreadyResolved = true;
        }
      }

      assignment = await this.service.advance(
        {
          assignmentId: params.assignmentId,
          expectedVersion: assignment.version,
          next: 'WAITING_FOR_REVIEW',
          outputRefs: [proposalResult.approvalRequestId ?? 'appr-req'],
          checkpointStage: 'AWAITING_REVIEW',
          references: {
            initialL2DecisionId: proposalResult.decisionId,
            l2ApprovalRequestId: proposalResult.approvalRequestId,
            triggerWaitToken: `wait-${assignment.assignmentId}-${randomUUID()}`,
          },
        },
        context
      );

      if (alreadyResolved) {
        return this.resumeAssignment(
          {
            assignmentId: params.assignmentId,
            scenarioId: params.scenarioId,
          },
          principal
        );
      }

      // Resolve-before-subscribe post-check:
      // Check if approval was resolved during waitpoint installation.
      if (this.decisionPort && proposalResult.approvalRequestId) {
        const postObservation = await this.decisionPort.getApprovalStatus(
          proposalResult.approvalRequestId,
          principal,
          params.scenarioId
        );
        if (postObservation && postObservation.status !== 'PENDING') {
          return this.resumeAssignment(
            {
              assignmentId: params.assignmentId,
              scenarioId: params.scenarioId,
            },
            principal
          );
        }
      }
    } else {
      assignment = await this.service.advance(
        {
          assignmentId: params.assignmentId,
          expectedVersion: assignment.version,
          next: 'COMPLETED',
          outputRefs: [proposalResult.decisionId],
          checkpointStage: 'FINISHED',
          references: { latestL2DecisionId: proposalResult.decisionId },
        },
        context
      );

    }

    return {
      assignment,
      outcome: proposalResult.outcome,
      decisionId: proposalResult.decisionId,
      approvalRequestId: proposalResult.approvalRequestId,
      evidenceView,
      policyExplanation,
      proposalResult,
    };
  }

  /**
   * Resumes a suspended assignment (WAITING_FOR_REVIEW) by observing the
   * authoritative L2 approval lifecycle (ADR-007 / L3 Contract Sec 5.5).
   */
  async resumeAssignment(
    params: {
      assignmentId: AssignmentId;
      scenarioId?: string;
    },
    principal: TrustedPrincipal
  ): Promise<WorkflowExecutionResult> {
    const assignment = await this.service.get(params.assignmentId, principal);

    if (assignment.tenantId !== principal.tenantId) {
      throw new HarnessError('CROSS_TENANT_ACCESS_DENIED', 'Tenant mismatch');
    }

    if (assignment.state === 'COMPLETED') {
      const latestDecision = assignment.latestL2DecisionId
        ? await this.store.getFinancialDecision(principal.tenantId, assignment.latestL2DecisionId)
        : null;

      return {
        assignment,
        evidenceView: {
          sourceId: assignment.caseId,
          sourceHashSha256: '',
          pipelineRunId: assignment.caseId,
          sourceDisposition: 'INVOICE_OR_UNCERTAIN',
          envelopes: [],
        },
        outcome: latestDecision?.outcome ?? 'AUTHORIZED_SIMULATED',
        decisionId: latestDecision?.decisionId,
        approvalRequestId: assignment.l2ApprovalRequestId,
      };
    }

    if (assignment.state !== 'WAITING_FOR_REVIEW') {
      throw new HarnessError(
        'INVALID_STATE_TRANSITION',
        `Cannot resume assignment in state ${assignment.state}: expected WAITING_FOR_REVIEW`
      );
    }

    if (!assignment.l2ApprovalRequestId) {
      throw new HarnessError(
        'APPROVAL_REQUEST_NOT_FOUND',
        `Assignment ${params.assignmentId} has no associated approval request ID`
      );
    }

    if (!this.decisionPort) {
      throw new HarnessError(
        'DECISION_PORT_REQUIRED',
        'Cannot resume approval without configured FinancialDecisionPort'
      );
    }

    const observation = await this.decisionPort.getApprovalStatus(
      assignment.l2ApprovalRequestId,
      principal,
      params.scenarioId
    );

    if (!observation) {
      throw new HarnessError(
        'APPROVAL_REQUEST_NOT_FOUND',
        `Approval request ${assignment.l2ApprovalRequestId} not found in L2 store`
      );
    }

    if (observation.status === 'PENDING') {
      return {
        assignment,
        evidenceView: {
          sourceId: assignment.caseId,
          sourceHashSha256: '',
          pipelineRunId: assignment.caseId,
          sourceDisposition: 'INVOICE_OR_UNCERTAIN',
          envelopes: [],
        },
        outcome: 'PENDING_HUMAN_APPROVAL',
        approvalRequestId: assignment.l2ApprovalRequestId,
      };
    }

    // Resolution occurred: RESOLVED (APPROVED), REJECTED, or EXPIRED
    let resolutionDecision: FinancialDecisionReference | null = null;
    let finalOutcome: FinancialOutcome = 'BLOCKED';

    if (observation.resolutionDecisionId) {
      resolutionDecision = await this.decisionPort.getDecision(
        observation.resolutionDecisionId,
        principal,
        params.scenarioId
      );
      if (resolutionDecision) {
        await this.store.saveFinancialDecision(principal.tenantId, resolutionDecision);
        finalOutcome = resolutionDecision.outcome;
      }
    }

    const nextVersion = assignment.version + 1;
    const now = new Date().toISOString();
    const updated: Assignment = {
      ...assignment,
      state: 'COMPLETED',
      version: nextVersion,
      latestL2DecisionId: observation.resolutionDecisionId ?? assignment.initialL2DecisionId,
      triggerWaitToken: undefined,
      updatedAt: now,
    };

    await this.store.saveAssignment(updated, assignment.version);

    await this.store.saveCheckpoint({
      checkpointId: `chk-${randomUUID()}`,
      tenantId: principal.tenantId,
      assignmentId: assignment.assignmentId,
      runId: assignment.activeRunId ?? `resume-${Date.now()}`,
      ownershipEpoch: assignment.ownershipEpoch,
      stage: 'FINISHED',
      inputRefs: [assignment.l2ApprovalRequestId],
      outputRefs: [observation.resolutionDecisionId ?? 'resolved'],
      recordedAt: now,
    });

    await this.store.recordExecutionEvent({
      eventId: `evt-${randomUUID()}`,
      tenantId: principal.tenantId,
      aggregateId: assignment.assignmentId,
      aggregateVersion: nextVersion,
      eventType: 'ASSIGNMENT_RESUMED_COMPLETED',
      commandId: observation.resolutionDecisionId ?? 'resolved',
      occurredAt: now,
    });

    await this.store.enqueueOutbox({
      eventId: `out-${randomUUID()}`,
      tenantId: principal.tenantId,
      eventType: 'ASSIGNMENT_RESOLVED',
      commandId: observation.resolutionDecisionId ?? 'resolved',
      payload: {
        assignmentId: assignment.assignmentId,
        approvalRequestId: assignment.l2ApprovalRequestId,
        outcome: finalOutcome,
        decisionId: observation.resolutionDecisionId,
        observationStatus: observation.status,
      },
      occurredAt: now,
    });

    return {
      assignment: updated,
      evidenceView: {
        sourceId: assignment.caseId,
        sourceHashSha256: '',
        pipelineRunId: assignment.caseId,
        sourceDisposition: 'INVOICE_OR_UNCERTAIN',
        envelopes: [],
      },
      outcome: finalOutcome,
      decisionId: observation.resolutionDecisionId,
      approvalRequestId: assignment.l2ApprovalRequestId,
    };
  }
}
