import { randomUUID } from 'node:crypto';
import type {
  Assignment,
  AssignmentId,
  AssignmentPort,
  AssignmentState,
  CaseSourceLink,
  CheckpointStage,
  CommandReceipt,
  ExecutionEvent,
  InboundEventReceipt,
  InboundMessageCommand,
  OutboxEvent,
  PayableCase,
  PayableCaseId,
  SpecialistRole,
  TrustedExecutionContext,
  TrustedPrincipal,
} from './types.js';
import type { HarnessStore } from './store.js';
import {
  assertValidTransition,
  HarnessError,
  validateExecutionFencing,
} from './state-machine.js';
import { computeInboundPayloadDigest } from './hashing.js';

export interface AssignmentServiceOptions {
  store: HarnessStore;
  defaultAgentPrincipalId?: string;
}

export class AssignmentService implements AssignmentPort {
  private readonly store: HarnessStore;
  private readonly defaultAgentPrincipalId: string;

  constructor(options: AssignmentServiceOptions) {
    this.store = options.store;
    this.defaultAgentPrincipalId =
      options.defaultAgentPrincipalId ?? 'agent-praeco-worker';
  }

  async createOrLoad(
    input: InboundMessageCommand,
    principal: TrustedPrincipal,
    options?: { sourceLinks?: readonly CaseSourceLink[]; signal?: AbortSignal }
  ): Promise<{ assignment: Assignment; isDuplicate: boolean }> {
    if (options?.signal?.aborted) {
      throw new HarnessError('EXECUTION_ABORTED', 'createOrLoad was aborted by cancellation signal');
    }

    const tenantId = principal.tenantId;

    // 1. Verify computed payload digest matches asserted digest if provided
    const computedDigest = computeInboundPayloadDigest(input);
    if (input.payloadDigest && input.payloadDigest !== computedDigest) {
      throw new HarnessError(
        'PAYLOAD_DIGEST_MISMATCH',
        `Inbound message asserted payloadDigest does not match calculated SHA-256 digest`
      );
    }

    // 2. Check for technical inbound event idempotency
    const existingReceipt = await this.store.getInboundReceipt(
      tenantId,
      input.provider,
      input.installationId,
      input.providerEventId
    );

    if (options?.signal?.aborted) {
      throw new HarnessError('EXECUTION_ABORTED', 'createOrLoad was aborted after checking inbound receipt');
    }

    if (existingReceipt) {
      // If same event ID arrives with different payload, fail closed immediately
      if (existingReceipt.payloadDigest !== computedDigest) {
        throw new HarnessError(
          'CONFLICTING_EVENT_PAYLOAD',
          `Conflicting payload digest under inbound event ${input.providerEventId}`
        );
      }
      const existingAssignment = await this.store.getAssignment(
        tenantId,
        existingReceipt.assignmentId
      );
      if (!existingAssignment) {
        throw new HarnessError(
          'CORRUPTED_INBOUND_STATE',
          `Inbound receipt points to nonexistent assignment ${existingReceipt.assignmentId}`
        );
      }
      return { assignment: existingAssignment, isDuplicate: true };
    }

    // 3. Resolve or create PayableCase workspace (by thread correlation or new case)
    let caseId = await this.store.findCaseByThread(
      tenantId,
      input.provider,
      input.installationId,
      input.providerThreadId
    );

    let caseData: PayableCase | undefined;
    let threadLink:
      | {
          provider: string;
          installationId: string;
          threadId: string;
          caseId: PayableCaseId;
        }
      | undefined;

    if (!caseId) {
      caseId = `case-${randomUUID()}`;
      caseData = {
        caseId,
        tenantId,
        sourceLinks: [],
        version: 1,
      };
      threadLink = {
        provider: input.provider,
        installationId: input.installationId,
        threadId: input.providerThreadId,
        caseId,
      };
    }

    // 4. Create fresh Assignment
    const now = new Date().toISOString();
    const assignmentId = `asgn-${randomUUID()}`;
    const assignment: Assignment = {
      assignmentId,
      tenantId,
      caseId,
      agentPrincipalId: this.defaultAgentPrincipalId,
      requestedByPrincipalId: principal.principalId,
      state: 'QUEUED',
      version: 1,
      ownershipEpoch: 1,
      createdAt: now,
      updatedAt: now,
    };

    const receipt: InboundEventReceipt = {
      receiptId: `rcpt-${randomUUID()}`,
      tenantId,
      provider: input.provider,
      installationId: input.installationId,
      providerEventId: input.providerEventId,
      payloadDigest: computedDigest,
      assignmentId,
      createdAt: now,
    };

    const commandReceipt: CommandReceipt = {
      commandReceiptId: `cmd-${randomUUID()}`,
      tenantId,
      scope: 'INBOUND_MESSAGE',
      commandKey: `${input.provider}:${input.installationId}:${input.providerEventId}`,
      payloadDigest: computedDigest,
      resultRef: assignmentId,
      createdAt: now,
    };

    const executionEvent: ExecutionEvent = {
      eventId: `evt-${randomUUID()}`,
      tenantId,
      aggregateId: assignmentId,
      aggregateVersion: 1,
      eventType: 'ASSIGNMENT_CREATED',
      commandId: input.providerEventId,
      occurredAt: now,
    };

    const outboxEvent: OutboxEvent = {
      eventId: `out-${randomUUID()}`,
      tenantId,
      installationId: input.installationId,
      eventType: 'ASSIGNMENT_QUEUED',
      commandId: input.providerEventId,
      payload: {
        assignmentId,
        caseId,
        provider: input.provider,
        threadId: input.providerThreadId,
      },
      occurredAt: now,
    };

    // 5. Transactional persistence covering inbound claiming, case/assignment, receipts and outbox
    if (options?.signal?.aborted) {
      throw new HarnessError('EXECUTION_ABORTED', 'createOrLoad was aborted before saving assignment');
    }

    return this.store.createInboundAssignment({
      receipt,
      commandReceipt,
      assignment,
      caseData,
      sourceLinks: options?.sourceLinks,
      threadLink,
      executionEvent,
      outboxEvent,
    });
  }

  async claimRun(
    input: {
      assignmentId: AssignmentId;
      triggerRunId: string;
      workerVersionId: string;
      specialistRole?: SpecialistRole;
    },
    principal: TrustedPrincipal
  ): Promise<TrustedExecutionContext> {
    const assignment = await this.get(input.assignmentId, principal);

    if (assignment.tenantId !== principal.tenantId) {
      throw new HarnessError('CROSS_TENANT_ACCESS_DENIED', 'Tenant mismatch');
    }

    // Must be transitionable to RUNNING
    assertValidTransition(assignment.state, 'RUNNING');

    const now = new Date().toISOString();
    const runId = `run-${randomUUID()}`;
    const nextEpoch = assignment.ownershipEpoch + 1;
    const nextVersion = assignment.version + 1;

    const run = {
      tenantId: principal.tenantId,
      assignmentId: assignment.assignmentId,
      runId,
      triggerRunId: input.triggerRunId,
      workerVersionId: input.workerVersionId,
      specialistRole: input.specialistRole,
      ownershipEpoch: nextEpoch,
      startedAt: now,
      status: 'ACTIVE' as const,
    };

    await this.store.saveRun(run);

    const updated: Assignment = {
      ...assignment,
      state: 'RUNNING',
      activeRunId: runId,
      ownershipEpoch: nextEpoch,
      version: nextVersion,
      updatedAt: now,
    };

    await this.store.saveAssignment(updated, assignment.version);

    await this.store.recordExecutionEvent({
      eventId: `evt-${randomUUID()}`,
      tenantId: principal.tenantId,
      aggregateId: assignment.assignmentId,
      aggregateVersion: nextVersion,
      eventType: 'RUN_CLAIMED',
      commandId: input.triggerRunId,
      occurredAt: now,
    });

    await this.store.enqueueOutbox({
      eventId: `out-${randomUUID()}`,
      tenantId: principal.tenantId,
      eventType: 'RUN_STARTED',
      commandId: input.triggerRunId,
      payload: {
        assignmentId: assignment.assignmentId,
        runId,
        ownershipEpoch: nextEpoch,
      },
      occurredAt: now,
    });

    return {
      principal,
      assignmentId: assignment.assignmentId,
      workerPrincipalId: this.defaultAgentPrincipalId,
      workerVersionId: input.workerVersionId,
      runId,
      ownershipEpoch: nextEpoch,
    };
  }

  async advance(
    input: {
      assignmentId: AssignmentId;
      expectedVersion: number;
      next: AssignmentState;
      outputRefs: readonly string[];
      checkpointStage?: CheckpointStage;
      references?: Pick<Assignment,
        'initialL2DecisionId' | 'latestL2DecisionId' | 'l2ApprovalRequestId' | 'triggerWaitToken'>;
    },
    context: TrustedExecutionContext
  ): Promise<Assignment> {
    const assignment = await this.get(input.assignmentId, context.principal);

    // Enforce fencing (version CAS, active epoch, active runId, tenant)
    validateExecutionFencing(assignment, context, input.expectedVersion);

    // Enforce legal transition rules
    assertValidTransition(assignment.state, input.next);

    const now = new Date().toISOString();
    const nextVersion = assignment.version + 1;

    const updated: Assignment = {
      ...assignment,
      initialL2DecisionId: input.references?.initialL2DecisionId ?? assignment.initialL2DecisionId,
      latestL2DecisionId: input.references?.latestL2DecisionId ?? assignment.latestL2DecisionId,
      l2ApprovalRequestId: input.references?.l2ApprovalRequestId ?? assignment.l2ApprovalRequestId,
      triggerWaitToken: input.references?.triggerWaitToken ?? assignment.triggerWaitToken,
      state: input.next,
      version: nextVersion,
      updatedAt: now,
    };

    await this.store.saveAssignment(updated, input.expectedVersion);

    if (input.checkpointStage) {
      await this.store.saveCheckpoint({
        checkpointId: `chk-${randomUUID()}`,
        tenantId: context.principal.tenantId,
        assignmentId: assignment.assignmentId,
        runId: context.runId,
        ownershipEpoch: context.ownershipEpoch,
        stage: input.checkpointStage,
        inputRefs: [],
        outputRefs: [...input.outputRefs],
        recordedAt: now,
      });
    }

    await this.store.recordExecutionEvent({
      eventId: `evt-${randomUUID()}`,
      tenantId: context.principal.tenantId,
      aggregateId: assignment.assignmentId,
      aggregateVersion: nextVersion,
      eventType: `ASSIGNMENT_STATE_${input.next}`,
      commandId: context.runId,
      occurredAt: now,
    });

    await this.store.enqueueOutbox({
      eventId: `out-${randomUUID()}`,
      tenantId: context.principal.tenantId,
      eventType: `ASSIGNMENT_STATE_${input.next}`,
      commandId: context.runId,
      payload: {
        assignmentId: assignment.assignmentId,
        state: input.next,
        version: nextVersion,
        outputRefs: input.outputRefs,
      },
      occurredAt: now,
    });

    return updated;
  }

  async get(
    assignmentId: AssignmentId,
    principal: TrustedPrincipal
  ): Promise<Assignment> {
    const assignment = await this.store.getAssignment(
      principal.tenantId,
      assignmentId
    );
    if (!assignment) {
      throw new HarnessError(
        'ASSIGNMENT_NOT_FOUND',
        `Assignment ${assignmentId} not found for tenant ${principal.tenantId}`
      );
    }
    return assignment;
  }
}
