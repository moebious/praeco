import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createL1, type L1Runtime } from '@praeco/evidence-intelligence';
import {
  createScenarioStore,
  FinancialAuthorizationService,
  L1EvidenceReaderAdapter,
  DEMO_TENANT_ID,
  type ScenarioId,
  type TransactionalFinancialStore,
} from '@praeco/financial-decision-kernel';

import {
  InMemoryHarnessStore,
  AssignmentService,
  WorkflowRunner,
  L1EvidencePortAdapter,
  L2FinancialDecisionAdapter,
  computeInboundPayloadDigest,
  type InboundMessageCommand,
  type TrustedPrincipal,
} from '../src/index.js';

describe('L3 Slices C & D — L1 + L2 End-to-End Orchestration', { timeout: 30_000 }, () => {
  let l1StorageDir: string;
  let l1: L1Runtime;
  let evidencePort: L1EvidencePortAdapter;
  let readerAdapter: L1EvidenceReaderAdapter;

  const demoSourcesRoot = new URL(
    '../../evidence-intelligence/test/fixtures/demo-day/sources/',
    import.meta.url
  );

  const PRINCIPAL_VERA: TrustedPrincipal = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-vera',
    roles: ['WorkerAgent'],
    bindingRevision: 'rev-1',
  };

  const PRINCIPAL_NOVA: TrustedPrincipal = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-nova',
    roles: ['WorkerAgent'],
    bindingRevision: 'rev-1',
  };

  const scenarioStores = new Map<ScenarioId, TransactionalFinancialStore>();

  function getScenarioStore(scenarioId: ScenarioId): TransactionalFinancialStore {
    let store = scenarioStores.get(scenarioId);
    if (!store) {
      store = createScenarioStore(scenarioId);
      scenarioStores.set(scenarioId, store);
    }
    return store;
  }

  function makeInboundCommand(
    eventId: string,
    attachmentRefs: readonly string[] = []
  ): InboundMessageCommand {
    const raw = {
      provider: 'EMAIL' as const,
      installationId: 'inst-1',
      providerEventId: eventId,
      providerUserId: 'user-01',
      providerThreadId: `thread-${eventId}`,
      messageId: `msg-${eventId}`,
      text: '',
      attachmentRefs,
    };
    const payloadDigest = computeInboundPayloadDigest(raw);
    return { ...raw, payloadDigest };
  }

  beforeAll(async () => {
    l1StorageDir = join(tmpdir(), `praeco-l3-slice-cd-${randomUUID()}`);
    l1 = await createL1({
      storageRoot: l1StorageDir,
      now: () => '2026-10-17T12:00:00Z',
    });
    evidencePort = new L1EvidencePortAdapter({ l1 });
    readerAdapter = new L1EvidenceReaderAdapter(l1.reader);
  });

  afterAll(async () => {
    await rm(l1StorageDir, { recursive: true, force: true });
  });

  function createTestWorkflowRunner(harnessStore: InMemoryHarnessStore) {
    const service = new AssignmentService({ store: harnessStore });

    const decisionPort = new L2FinancialDecisionAdapter({
      resolveService: (_tenantId: string, scenarioId?: string) => {
        const sid = (scenarioId ?? 'BLINKA-01') as ScenarioId;
        const store = getScenarioStore(sid);
        const authService = new FinancialAuthorizationService(store, readerAdapter);
        return { service: authService, store };
      },
    });

    return new WorkflowRunner({
      store: harnessStore,
      service,
      evidencePort,
      decisionPort,
    });
  }

  describe('The Canonical 8 Blinka Scenarios (Zero Fake Evidence)', () => {
    it('Blinka-01: Bogotá contractor developer -> AUTHORIZED_SIMULATED', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      // 1. Ingest real 01.pdf through EvidencePort
      const pdfBytes = await readFile(new URL('01.pdf', demoSourcesRoot));
      const executionCtx = {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-01',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-01',
        ownershipEpoch: 1,
      };

      const evRef = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '01.pdf',
        },
        executionCtx
      );

      expect(evRef.sourceDisposition).toBe('INVOICE_OR_UNCERTAIN');
      expect(evRef.envelopeIds).toHaveLength(1);

      // 2. Create PayableCase and attach source link
      const caseId = 'case-blinka-01';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      // 3. Create Assignment
      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-01', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      // Link assignment to case
      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      // 4. Run end-to-end workflow
      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-01',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-01',
        },
        PRINCIPAL_VERA
      );

      // Invariant: Never mark simulated authorization as PAID
      expect(result.outcome).toBe('AUTHORIZED_SIMULATED');
      expect(result.assignment.state).toBe('COMPLETED');
      expect(result.evidenceView.envelopes[0]?.maskedAccount).toBe('***NT-A');

      // Verify L2 ledger effect
      const store = getScenarioStore('BLINKA-01');
      const budget = store.budgets.get('BUDGET-2026-10');
      expect(budget?.committedUsd).toBe('2200');
    });

    it('Blinka-02: Cloud SaaS provider (multi-source: 02.pdf + 02-context.txt) -> AUTHORIZED_SIMULATED', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const executionCtx = {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-02',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-02',
        ownershipEpoch: 1,
      };

      // 1. Ingest primary invoice PDF
      const pdfBytes = await readFile(new URL('02.pdf', demoSourcesRoot));
      const evRef1 = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '02.pdf',
        },
        executionCtx
      );

      // 2. Ingest supplemental email context
      const txtBytes = await readFile(new URL('02-context.txt', demoSourcesRoot));
      const evRef2 = await evidencePort.ingestSource(
        {
          bytes: txtBytes,
          channel: 'EMAIL',
          mimeType: 'text/plain',
          displayName: '02-context.txt',
          originMessageId: 'email-cloud-context',
        },
        executionCtx
      );

      expect(evRef2.sourceDisposition).toBe('SUPPLEMENTAL_CONTEXT');
      expect(evRef2.envelopeIds).toHaveLength(0);

      // 3. Multi-source PayableCase correlation
      const caseId = 'case-blinka-02';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef1,
      });
      const updatedCase = await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef2,
      });

      expect(updatedCase.version).toBe(2);
      expect(updatedCase.sourceLinks).toHaveLength(2);

      // 4. Create and run Assignment
      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-02', [evRef1.sourceId, evRef2.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-02',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-02',
        },
        PRINCIPAL_VERA
      );

      expect(result.outcome).toBe('AUTHORIZED_SIMULATED');
      expect(result.assignment.state).toBe('COMPLETED');
    });

    it('Blinka-03: Mexico contractor threshold escalation -> PENDING_HUMAN_APPROVAL (WAITING_FOR_REVIEW)', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '03.pdf',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-03',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-ingest-03',
          ownershipEpoch: 1,
        }
      );

      const caseId = 'case-blinka-03';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-03', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-03',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-03',
        },
        PRINCIPAL_VERA
      );

      // Escalation outcome suspends at WAITING_FOR_REVIEW
      expect(result.outcome).toBe('PENDING_HUMAN_APPROVAL');
      expect(result.assignment.state).toBe('WAITING_FOR_REVIEW');
      expect(result.approvalRequestId).toBeDefined();
      expect(result.assignment.l2ApprovalRequestId).toBe(result.approvalRequestId);

      // Verify G6 explanation
      const g6 = result.policyExplanation?.gateExplanations.find(
        (g) => g.gateName === 'G6'
      );
      expect(g6?.status).toBe('ESCALATE');
      expect(g6?.reasonCode).toBe('AUTO_APPROVAL_THRESHOLD_EXCEEDED');
    });

    it('Blinka-04: Argentina contractor undocumented bonus (multi-source) -> BLOCKED (G4)', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const executionCtx = {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-04',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-04',
        ownershipEpoch: 1,
      };

      // 1. Ingest primary invoice PDF (USD 1,950 requested)
      const pdfBytes = await readFile(new URL('04.pdf', demoSourcesRoot));
      const evRef1 = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '04.pdf',
        },
        executionCtx
      );

      // 2. Ingest supplemental bonus context (informal note)
      const txtBytes = await readFile(new URL('04-context.txt', demoSourcesRoot));
      const evRef2 = await evidencePort.ingestSource(
        {
          bytes: txtBytes,
          channel: 'CHAT',
          mimeType: 'text/plain',
          displayName: '04-context.txt',
          originMessageId: 'chat-bonus-note',
        },
        executionCtx
      );

      const caseId = 'case-blinka-04';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef1,
      });
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef2,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-04', [evRef1.sourceId, evRef2.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-04',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-04',
        },
        PRINCIPAL_VERA
      );

      expect(result.outcome).toBe('BLOCKED');
      expect(result.assignment.state).toBe('COMPLETED');
      expect(result.policyExplanation?.dominantReason).toBe('CONTRACT_AMOUNT_MISMATCH');
    });

    it('Blinka-05: Forwarded email invoice duplicate -> BLOCKED (G2)', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const txtBytes = await readFile(new URL('05.txt', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: txtBytes,
          channel: 'EMAIL',
          mimeType: 'text/plain',
          displayName: '05.txt',
          originMessageId: 'email-forward-05',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-05',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-ingest-05',
          ownershipEpoch: 1,
        }
      );

      const caseId = 'case-blinka-05';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-05', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-05',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-05',
        },
        PRINCIPAL_VERA
      );

      expect(result.outcome).toBe('BLOCKED');
      expect(result.assignment.state).toBe('COMPLETED');
      expect(['G2_DUPLICATE', 'G2_CONFLICT']).toContain(result.policyExplanation?.dominantReason);
    });

    it('Blinka-06: Unknown Colombian vendor not allowlisted -> BLOCKED (G3)', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const pdfBytes = await readFile(new URL('06.pdf', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '06.pdf',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-06',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-ingest-06',
          ownershipEpoch: 1,
        }
      );

      const caseId = 'case-blinka-06';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-06', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-06',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-06',
        },
        PRINCIPAL_VERA
      );

      expect(result.outcome).toBe('BLOCKED');
      expect(result.policyExplanation?.dominantReason).toBe('BENEFICIARY_NOT_ALLOWLISTED');
    });

    it('Blinka-07: Over budget payable -> BLOCKED (G5)', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const pdfBytes = await readFile(new URL('07.pdf', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '07.pdf',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-07',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-ingest-07',
          ownershipEpoch: 1,
        }
      );

      const caseId = 'case-blinka-07';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-07', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-07',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-07',
        },
        PRINCIPAL_VERA
      );

      expect(result.outcome).toBe('BLOCKED');
      expect(result.policyExplanation?.dominantReason).toBe('INSUFFICIENT_PERIOD_BUDGET');
    });

    it('Blinka-08: Altered payment account -> BLOCKED (G3)', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      const pdfBytes = await readFile(new URL('08.pdf', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '08.pdf',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-08',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-ingest-08',
          ownershipEpoch: 1,
        }
      );

      const caseId = 'case-blinka-08';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-08', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-08',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-08',
        },
        PRINCIPAL_VERA
      );

      expect(result.outcome).toBe('BLOCKED');
      expect(result.policyExplanation?.dominantReason).toBe('PAYMENT_ACCOUNT_MISMATCH');
    });
  });

  describe('Adversarial & Financial Safety Guards', () => {
    it('Supplemental-only intake never creates a financial intent or commits to L2', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);
      const service = new AssignmentService({ store: harnessStore });

      // Ingest 04-context.txt alone as supplemental context
      const txtBytes = await readFile(new URL('04-context.txt', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: txtBytes,
          channel: 'CHAT',
          mimeType: 'text/plain',
          displayName: '04-context.txt',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-supp-only',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-supp',
          ownershipEpoch: 1,
        }
      );

      expect(evRef.sourceDisposition).toBe('SUPPLEMENTAL_CONTEXT');
      expect(evRef.envelopeIds).toHaveLength(0);

      const caseId = 'case-supp-only';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      const { assignment } = await service.createOrLoad(
        makeInboundCommand('evt-supp', [evRef.sourceId]),
        PRINCIPAL_VERA
      );

      assignment.caseId = caseId;
      await harnessStore.saveAssignment(assignment);

      const result = await runner.executeAssignmentWorkflow(
        {
          assignmentId: assignment.assignmentId,
          triggerRunId: 'trig-supp',
          sourceReference: caseId,
          requestedBudgetId: 'BUDGET-2026-10',
          scenarioId: 'BLINKA-04',
        },
        PRINCIPAL_VERA
      );

      // Completed safely as supplemental context without financial intent or L2 commitment
      expect(result.isSupplementalOnly).toBe(true);
      expect(result.outcome).toBeUndefined();
      expect(result.proposalResult).toBeUndefined();
      expect(harnessStore.financialIntents.size).toBe(0);
      expect(harnessStore.financialDecisions.size).toBe(0);
    });

    it('Direct Nova intent preparation fails closed on supplemental-only evidence', async () => {
      const harnessStore = new InMemoryHarnessStore();
      const runner = createTestWorkflowRunner(harnessStore);

      const txtBytes = await readFile(new URL('04-context.txt', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: txtBytes,
          channel: 'CHAT',
          mimeType: 'text/plain',
          displayName: '04-context.txt',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-hack',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-hack',
          ownershipEpoch: 1,
        }
      );

      const caseId = 'case-hack';
      await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
        kind: 'DOCUMENT',
        evidence: evRef,
      });

      // Attempting to forge an intent with empty or invalid envelope on supplemental case
      const novaTools = runner['registry'].listToolsForRole('NOVA');
      const prepareTool = novaTools.find((t) => t.name === 'prepare_financial_intent');
      expect(prepareTool).toBeDefined();

      await expect(
        prepareTool!.execute(
          {
            caseId,
            envelopeId: '',
            requestedBudgetId: 'BUDGET-2026-10',
          },
          {
            principal: PRINCIPAL_NOVA,
            assignmentId: 'asg-hack',
            workerPrincipalId: 'worker-nova',
            workerVersionId: 'v1.0.0',
            runId: 'run-hack-2',
            ownershipEpoch: 1,
          }
        )
      ).rejects.toThrow();
    });

    it('Cross-tenant isolation: Tenant B cannot load Tenant A ready evidence', async () => {
      const pdfBytes = await readFile(new URL('01.pdf', demoSourcesRoot));
      const evRef = await evidencePort.ingestSource(
        {
          bytes: pdfBytes,
          channel: 'PDF',
          mimeType: 'application/pdf',
          displayName: '01.pdf',
        },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-tenant-a',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-ta',
          ownershipEpoch: 1,
        }
      );

      const envelopeId = evRef.envelopeIds[0]!;

      const TENANT_B_PRINCIPAL: TrustedPrincipal = {
        tenantId: 'tenant-adversary',
        principalId: 'attacker',
        roles: ['WorkerAgent'],
        bindingRevision: 'rev-1',
      };

      await expect(
        evidencePort.loadReady(envelopeId, TENANT_B_PRINCIPAL)
      ).rejects.toThrow();
    });
  });
});
