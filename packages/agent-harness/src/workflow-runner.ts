import type {
  Assignment,
  AssignmentId,
  EvidencePort,
  FinancialDecisionPort,
  FinancialOutcome,
  TrustedExecutionContext,
  TrustedPrincipal,
} from './types.js';
import type { HarnessStore } from './store.js';
import type { AssignmentService } from './service.js';
import { SpecialistToolRegistry } from './specialists/registry.js';
import { BoundedSpecialistRunner } from './specialists/runner.js';
import { createVeraTools } from './specialists/vera.js';
import { createKaelTools } from './specialists/kael.js';
import { createNovaTools } from './specialists/nova.js';
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
}

export interface WorkflowExecutionParams {
  assignmentId: AssignmentId;
  triggerRunId: string;
  sourceReference: string;
  requestedBudgetId: string;
  scenarioId?: string;
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

  constructor(options: WorkflowRunnerOptions) {
    this.store = options.store;
    this.service = options.service;
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

    this.runner = new BoundedSpecialistRunner(this.registry, options.specialistLimits);
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
    const envelopeId = evidenceView.envelopes[0]!.envelopeId;
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
      assignment = await this.service.advance(
        {
          assignmentId: params.assignmentId,
          expectedVersion: assignment.version,
          next: 'WAITING_FOR_REVIEW',
          outputRefs: [proposalResult.approvalRequestId ?? 'appr-req'],
          checkpointStage: 'AWAITING_REVIEW',
        },
        context
      );

      // Attach approval request ID and decision ID
      assignment.initialL2DecisionId = proposalResult.decisionId;
      assignment.l2ApprovalRequestId = proposalResult.approvalRequestId;
      await this.store.saveAssignment(assignment);
    } else {
      assignment = await this.service.advance(
        {
          assignmentId: params.assignmentId,
          expectedVersion: assignment.version,
          next: 'COMPLETED',
          outputRefs: [proposalResult.decisionId],
          checkpointStage: 'FINISHED',
        },
        context
      );

      assignment.latestL2DecisionId = proposalResult.decisionId;
      await this.store.saveAssignment(assignment);
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
}
