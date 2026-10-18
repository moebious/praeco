import { describe, expect, it, beforeEach } from 'vitest';
import {
  AssignmentService,
  InMemoryHarnessStore,
  FakeChannelAdapter,
  WorkflowRunner,
  SpecialistToolRegistry,
  BoundedSpecialistRunner,
  createVeraTools,
  createKaelTools,
  createNovaTools,
  type TrustedPrincipal,
} from '../src/index.js';

import { DEMO_TENANT_ID } from '@praeco/financial-decision-kernel';

describe('Layer 3 Slice B — Durable Workflow & Specialist Roles', () => {
  let store: InMemoryHarnessStore;
  let service: AssignmentService;
  let adapter: FakeChannelAdapter;
  let workflowRunner: WorkflowRunner;
  let registry: SpecialistToolRegistry;

  const TENANT_ID = DEMO_TENANT_ID;
  const PRINCIPAL: TrustedPrincipal = {
    tenantId: TENANT_ID,
    principalId: 'cfo-alice',
    roles: ['FinanceAdmin'],
    bindingRevision: 'rev-1',
  };

  beforeEach(async () => {
    store = new InMemoryHarnessStore();
    service = new AssignmentService({ store });
    adapter = new FakeChannelAdapter(store, service);
    workflowRunner = new WorkflowRunner({ store, service });

    registry = new SpecialistToolRegistry();
    for (const tool of createVeraTools({ store })) registry.registerTool(tool);
    for (const tool of createKaelTools({ store })) registry.registerTool(tool);
    for (const tool of createNovaTools({ store })) registry.registerTool(tool);

    await store.registerPrincipalBinding({
      tenantId: TENANT_ID,
      provider: 'EMAIL',
      installationId: 'mail-mx-1',
      providerUserId: 'ap@blinka.com',
      principalId: 'cfo-alice',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: false,
    });
  });

  describe('Specialist Role Boundaries & Tool Access Control', () => {
    it('prevents Vera from executing Nova financial proposal tools', async () => {
      const context = {
        principal: PRINCIPAL,
        assignmentId: 'asgn-mock',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-01',
        ownershipEpoch: 1,
      };

      await expect(
        registry.executeTool(
          'submit_financial_proposal',
          'VERA', // Unauthorized! Only NOVA is allowed
          { intentId: 'intent-mock' },
          context
        )
      ).rejects.toThrow('UNAUTHORIZED_SPECIALIST_ROLE');
    });

    it('prevents Kael from preparing financial intents', async () => {
      const context = {
        principal: PRINCIPAL,
        assignmentId: 'asgn-mock',
        workerPrincipalId: 'worker-kael',
        workerVersionId: 'v1.0.0',
        runId: 'run-01',
        ownershipEpoch: 1,
      };

      await expect(
        registry.executeTool(
          'prepare_financial_intent',
          'KAEL', // Unauthorized! Only NOVA is allowed
          { caseId: 'c-1', envelopeId: 'e-1', requestedBudgetId: 'b-1' },
          context
        )
      ).rejects.toThrow('UNAUTHORIZED_SPECIALIST_ROLE');
    });

    it('guarantees Kael policy evaluation is strictly read-only', async () => {
      const context = {
        principal: PRINCIPAL,
        assignmentId: 'asgn-mock',
        workerPrincipalId: 'worker-kael',
        workerVersionId: 'v1.0.0',
        runId: 'run-01',
        ownershipEpoch: 1,
      };

      const explanation = (await registry.executeTool(
        'explain_policy_evaluation',
        'KAEL',
        { envelopeId: 'env-bogota-01', scenarioId: 'BLINKA-01' },
        context
      )) as any;

      expect(explanation.outcome).toBe('AUTHORIZED_SIMULATED');
      expect(explanation.gateExplanations).toHaveLength(6);

      // Verify no commitments or decisions written to store
      expect(store.financialDecisions.size).toBe(0);
      expect(store.financialIntents.size).toBe(0);
    });

    it('fails closed when the envelope does not match any scenario', async () => {
      const context = {
        principal: PRINCIPAL,
        assignmentId: 'asgn-mock',
        workerPrincipalId: 'worker-kael',
        workerVersionId: 'v1.0.0',
        runId: 'run-01',
        ownershipEpoch: 1,
      };

      // An unknown envelope must error instead of silently evaluating an
      // unrelated synthetic invoice.
      await expect(
        registry.executeTool(
          'explain_policy_evaluation',
          'KAEL',
          { envelopeId: 'env-does-not-exist' },
          context
        )
      ).rejects.toThrow('SCENARIO_NOT_FOUND');
    });
  });

  describe('Bounded Execution & Resource Deadlines', () => {
    it('terminates and rejects execution loops that exceed step bounds', async () => {
      const boundedRunner = new BoundedSpecialistRunner(registry, { maxSteps: 2 });
      const context = {
        principal: PRINCIPAL,
        assignmentId: 'asgn-mock',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-01',
        ownershipEpoch: 1,
      };

      const steps = [
        { toolName: 'verify_source_digest', params: { sourceId: 's1', expectedHash: 'a'.repeat(64) } },
        { toolName: 'verify_source_digest', params: { sourceId: 's2', expectedHash: 'b'.repeat(64) } },
        { toolName: 'verify_source_digest', params: { sourceId: 's3', expectedHash: 'c'.repeat(64) } }, // 3rd step exceeds bound of 2!
      ];

      await expect(
        boundedRunner.runSpecialistLoop('VERA', steps, context)
      ).rejects.toThrow('MAX_STEPS_EXCEEDED');
    });

    it('terminates loops that exceed execution deadline', async () => {
      const boundedRunner = new BoundedSpecialistRunner(registry, { timeoutMs: 0 }); // 0ms timeout forces immediate deadline trip
      const context = {
        principal: PRINCIPAL,
        assignmentId: 'asgn-mock',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-01',
        ownershipEpoch: 1,
      };

      const steps = [
        { toolName: 'verify_source_digest', params: { sourceId: 's1', expectedHash: 'a'.repeat(64) } },
      ];

      await expect(
        boundedRunner.runSpecialistLoop('VERA', steps, context)
      ).rejects.toThrow('EXECUTION_DEADLINE_EXCEEDED');
    });
  });

  describe('End-to-End Workflow & Checkpointed Progression', () => {
    it('executes Scenario 01 end-to-end: Vera -> Kael -> Nova -> AUTHORIZED_SIMULATED -> COMPLETED', async () => {
      // 1. Inbound intake
      const inbound = await adapter.handleInboundWebhook(TENANT_ID, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'mail-blinka-01',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-blinka-01',
        text: 'Invoice from Bogota developer',
        attachmentRefs: ['01.pdf'],
      });

      // 2. Execute durable workflow
      const result = await workflowRunner.executeAssignmentWorkflow(
        {
          assignmentId: inbound.assignmentId,
          triggerRunId: 'trig-run-001',
          sourceReference: '01.pdf',
          requestedBudgetId: 'bud-eng-2026-10',
          scenarioId: 'BLINKA-01',
        },
        PRINCIPAL
      );

      // Verify outcomes and state progression
      expect(result.outcome).toBe('AUTHORIZED_SIMULATED');
      expect(result.assignment.state).toBe('COMPLETED');
      expect(result.assignment.latestL2DecisionId).toBeDefined();

      // Verify checkpoints recorded in order
      const checkpoints = await store.getCheckpoints(TENANT_ID, inbound.assignmentId);
      const stages = checkpoints.map((c) => c.stage);
      expect(stages).toEqual([
        'EVIDENCE_RESOLVED',
        'L2_INTENT_RECORDED',
        'L2_DECISION_RECORDED',
        'FINISHED',
      ]);
    });

    it('executes Scenario 03 threshold escalation: suspends into WAITING_FOR_REVIEW with approval request', async () => {
      // 1. Inbound intake
      const inbound = await adapter.handleInboundWebhook(TENANT_ID, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'mail-blinka-03',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-blinka-03',
        text: 'Invoice from Mexico design agency exceeding threshold',
        attachmentRefs: ['03.pdf'],
      });

      // 2. Execute durable workflow for Case 03 (USD 3,800 > USD 2,500 threshold)
      const result = await workflowRunner.executeAssignmentWorkflow(
        {
          assignmentId: inbound.assignmentId,
          triggerRunId: 'trig-run-003',
          sourceReference: '03.pdf',
          requestedBudgetId: 'bud-design-2026-10',
          scenarioId: 'BLINKA-03',
        },
        PRINCIPAL
      );

      expect(result.outcome).toBe('PENDING_HUMAN_APPROVAL');
      expect(result.assignment.state).toBe('WAITING_FOR_REVIEW');
      expect(result.assignment.initialL2DecisionId).toBeDefined();
      expect(result.assignment.l2ApprovalRequestId).toBeDefined();

      // Verify checkpoints
      const checkpoints = await store.getCheckpoints(TENANT_ID, inbound.assignmentId);
      const stages = checkpoints.map((c) => c.stage);
      expect(stages).toEqual([
        'EVIDENCE_RESOLVED',
        'L2_INTENT_RECORDED',
        'L2_DECISION_RECORDED',
        'AWAITING_REVIEW',
      ]);
    });

    it('executes Scenario 08 hard block: completes investigation with BLOCKED decision reference', async () => {
      const inbound = await adapter.handleInboundWebhook(TENANT_ID, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'mail-blinka-08',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-blinka-08',
        text: 'Invoice with tampered payment account',
        attachmentRefs: ['08.pdf'],
      });

      const result = await workflowRunner.executeAssignmentWorkflow(
        {
          assignmentId: inbound.assignmentId,
          triggerRunId: 'trig-run-08',
          sourceReference: '08.pdf',
          requestedBudgetId: 'bud-general-2026-10',
          scenarioId: 'BLINKA-08',
        },
        PRINCIPAL
      );

      expect(result.outcome).toBe('BLOCKED');
      expect(result.assignment.state).toBe('COMPLETED');
      expect(result.policyExplanation?.dominantReason).toBe('PAYMENT_ACCOUNT_MISMATCH');
    });

    it('guarantees retry idempotency without double ledger dispatch', async () => {
      const inbound = await adapter.handleInboundWebhook(TENANT_ID, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'mail-retry-test',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-retry',
      });

      // First execution
      const first = await workflowRunner.executeAssignmentWorkflow(
        {
          assignmentId: inbound.assignmentId,
          triggerRunId: 'trig-run-first',
          sourceReference: '01.pdf',
          requestedBudgetId: 'bud-eng-2026-10',
          scenarioId: 'BLINKA-01',
        },
        PRINCIPAL
      );

      expect(first.outcome).toBe('AUTHORIZED_SIMULATED');

      // Nova retry dispatch using the same intent
      const context = {
        principal: PRINCIPAL,
        assignmentId: inbound.assignmentId,
        workerPrincipalId: 'worker-nova',
        workerVersionId: 'v1.0.0',
        runId: 'run-retry',
        ownershipEpoch: 2,
      };

      const secondProposal = (await registry.executeTool(
        'submit_financial_proposal',
        'NOVA',
        { intentId: first.proposalResult!.intentId, scenarioId: 'BLINKA-01' },
        context
      )) as any;

      // Reconciles and returns the exact same decision ID without duplicating
      expect(secondProposal.decisionId).toBe(first.decisionId);
      expect(secondProposal.explanation).toContain('reconciliado por idempotencia');
    });
  });
});
