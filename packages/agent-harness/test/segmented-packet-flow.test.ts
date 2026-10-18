import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createL1 } from '@praeco/evidence-intelligence';
import {
  computeAccountFingerprint,
  createScenarioStore,
  DEFAULT_SYNTHETIC_HMAC_KEY,
  FinancialAuthorizationService,
  L1EvidenceReaderAdapter,
  DEMO_TENANT_ID,
  type ScenarioId,
  type TransactionalFinancialStore,
} from '@praeco/financial-decision-kernel';
import {
  SegmentedLabelledTextExtractor,
  StaticSegmentClassificationSource,
  validateSplitResult,
} from '@praeco/document-classification-adapter';
import {
  AssignmentService,
  InMemoryHarnessStore,
  L1EvidencePortAdapter,
  L2FinancialDecisionAdapter,
  WorkflowRunner,
  computeInboundPayloadDigest,
  type InboundMessageCommand,
  type TrustedPrincipal,
} from '../src/index.js';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

/** Invoice A mirrors the seeded BLINKA-01 vendor (CO-900.123.456-7, USD 2200). */
const INVOICE_A = [
  'SYNTHETIC INVOICE — NOT A REAL COMPANY OR PAYMENT',
  'Invoice number: SYN-A-2026',
  'Issue date: 2026-10-01',
  'Due date: 2026-10-31',
  'Beneficiary: Bogota Contractor LLC',
  'Tax ID: CO-900.123.456-7',
  'Payment rail: BANK',
  'Account: 9876543210',
  'Contract: CTR-BOG-01',
  'Description: Synthetic engineering services',
  'Currency: USD',
  'Subtotal: 2200',
  'Taxes: 0',
  'Discounts: 0',
  'Total due: 2200',
  'Already paid: 0',
  'Outstanding balance: 2200',
].join('\n');

/** Invoice B mirrors the seeded BLINKA-02 cloud vendor (SYN-TAX-CLOUD, USD 470). */
const INVOICE_B = [
  'SYNTHETIC INVOICE — NOT A REAL COMPANY OR PAYMENT',
  'Invoice number: SYN-B-2026',
  'Issue date: 2026-10-01',
  'Due date: 2026-10-31',
  'Beneficiary: Synthetic Cloud Infrastructure',
  'Tax ID: SYN-TAX-CLOUD',
  'Payment rail: BANK',
  'Account: SYN-CLOUD-ACCOUNT-A',
  'Contract: SYN-CONTRACT-2',
  'Description: Synthetic cloud services',
  'Currency: USD',
  'Subtotal: 470',
  'Taxes: 0',
  'Discounts: 0',
  'Total due: 470',
  'Already paid: 0',
  'Outstanding balance: 470',
].join('\n');

const CONTRACT_PAGE = [
  'SERVICE CONTRACT 72',
  'Agreement between Demo Company and Bogota Contractor LLC.',
  'This contract does not request any payment.',
].join('\n');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const PRINCIPAL_VERA: TrustedPrincipal = {
  tenantId: DEMO_TENANT_ID,
  principalId: 'worker-vera',
  roles: ['WorkerAgent'],
  bindingRevision: 'rev-1',
};

describe('L3 verified-segment flow: mixed packet to L2 authorization', () => {
  let l1StorageDir: string;
  let l1: Awaited<ReturnType<typeof createL1>>;
  let evidencePort: L1EvidencePortAdapter;
  let readerAdapter: L1EvidenceReaderAdapter;
  const scenarioStores = new Map<ScenarioId, TransactionalFinancialStore>();

  function getScenarioStore(scenarioId: ScenarioId): TransactionalFinancialStore {
    let store = scenarioStores.get(scenarioId);
    if (!store) {
      store = createScenarioStore(scenarioId);
      scenarioStores.set(scenarioId, store);
    }
    return store;
  }

  function makeInboundCommand(eventId: string, attachmentRefs: readonly string[]): InboundMessageCommand {
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
    return { ...raw, payloadDigest: computeInboundPayloadDigest(raw) };
  }

  function createRunner(harnessStore: InMemoryHarnessStore): WorkflowRunner {
    const service = new AssignmentService({ store: harnessStore });
    const decisionPort = new L2FinancialDecisionAdapter({
      resolveService: (_tenantId: string, scenarioId?: string) => {
        const store = getScenarioStore((scenarioId ?? 'BLINKA-01') as ScenarioId);
        return { service: new FinancialAuthorizationService(store, readerAdapter), store };
      },
    });
    return new WorkflowRunner({ store: harnessStore, service, evidencePort, decisionPort });
  }

  function classificationFor(pageCount: number, segments: Array<{ category: string; pages: number[]; needsReview?: boolean }>) {
    return validateSplitResult(
      {
        schema_version: '1',
        task: 'split',
        segments: segments.map((segment, index) => ({
          id: `segment-${String(index + 1).padStart(3, '0')}`,
          category: segment.category,
          pages: segment.pages,
          needs_review: segment.needsReview ?? false,
          review_reasons: [],
        })),
        warnings: [],
        document: { page_count: pageCount, source_sha256: SHA_A, canonical_sha256: SHA_B },
        engine: 'jev',
        model: 'jev-1.14',
        metrics: { decision_ms: 250, decision_cost_usd: 0.00005 },
      },
      { expectedPageCount: pageCount }
    );
  }

  beforeAll(async () => {
    l1StorageDir = join(tmpdir(), `praeco-l3-segments-${randomUUID()}`);
    // Mixed packet: invoice (p1), contract (p2), invoice (p3).
    const packetBytes = Buffer.from([INVOICE_A, CONTRACT_PAGE, INVOICE_B].join('\f'));
    const classification = classificationFor(3, [
      { category: 'invoice', pages: [1] },
      { category: 'contract', pages: [2] },
      { category: 'invoice', pages: [3] },
    ]);
    l1 = await createL1({
      storageRoot: l1StorageDir,
      now: () => '2026-10-17T12:00:00Z',
      extractor: new SegmentedLabelledTextExtractor({
        classification: new StaticSegmentClassificationSource([
          { sourceHashSha256: sha256(packetBytes), packet: classification },
        ]),
      }),
    });
    evidencePort = new L1EvidencePortAdapter({ l1 });
    readerAdapter = new L1EvidenceReaderAdapter(l1.reader);
    (globalThis as Record<string, unknown>).__praecoPacketBytes = packetBytes;
  });

  afterAll(async () => {
    await rm(l1StorageDir, { recursive: true, force: true });
  });

  it('splits a mixed packet into two verified invoices and authorizes both through L2', async () => {
    const packetBytes = (globalThis as Record<string, unknown>).__praecoPacketBytes as Buffer;
    const harnessStore = new InMemoryHarnessStore();
    const runner = createRunner(harnessStore);
    const service = new AssignmentService({ store: harnessStore });

    const executionCtx = {
      principal: PRINCIPAL_VERA,
      assignmentId: 'asg-segments',
      workerPrincipalId: 'worker-vera',
      workerVersionId: 'v1.0.0',
      runId: 'run-ingest-segments',
      ownershipEpoch: 1,
    };

    const evRef = await evidencePort.ingestSource(
      { bytes: packetBytes, channel: 'CHAT', mimeType: 'text/plain', displayName: 'mixed-packet.txt' },
      executionCtx
    );
    expect(evRef.sourceDisposition).toBe('INVOICE_OR_UNCERTAIN');
    expect(evRef.envelopeIds).toHaveLength(2);

    const [envelopeIdA, envelopeIdB] = evRef.envelopeIds as [string, string];

    // Segment provenance and original-page citations survive the L1 read boundary.
    const readyA = await l1.reader.loadReady(DEMO_TENANT_ID, envelopeIdA);
    expect(readyA.envelope.segment).toMatchObject({ startPage: 1, endPage: 1, classifiedBy: 'DOCJEV', category: 'INVOICE' });
    expect(readyA.envelope.provenance.classification.provider).toBe('DOCJEV');
    expect(readyA.envelope.evidence.every(item => item.segmentId === readyA.envelope.segment!.segmentId)).toBe(true);
    expect(readyA.envelope.source.sourceHashSha256).toBe(sha256(packetBytes));

    const readyB = await l1.reader.loadReady(DEMO_TENANT_ID, envelopeIdB);
    expect(readyB.envelope.segment).toMatchObject({ startPage: 3, endPage: 3, classifiedBy: 'DOCJEV' });

    // Attach the packet source to both payable cases.
    const caseA = 'case-segment-a';
    const caseB = 'case-segment-b';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseA, { kind: 'DOCUMENT', evidence: evRef });
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseB, { kind: 'DOCUMENT', evidence: evRef });

    // The labelled-text protocol carries account claims as rail + account
    // identifier only, so the seeded vendor directory must be configured for
    // that claim shape (the PDF fixtures carry richer claims). Patch before
    // any decision runs.
    const bogotaVendor = getScenarioStore('BLINKA-01').vendors.get('VENDOR-BOG')!;
    bogotaVendor.paymentAccountFingerprint = computeAccountFingerprint(
      DEMO_TENANT_ID,
      { rail: 'BANK', accountIdentifier: '9876543210' },
      DEFAULT_SYNTHETIC_HMAC_KEY
    );

    // Invoice A: seeded BLINKA-01 vendor, exact 2200 USD contract.
    const { assignment: assignmentA } = await service.createOrLoad(
      makeInboundCommand('evt-seg-a', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignmentA.caseId = caseA;
    await harnessStore.saveAssignment(assignmentA);
    const resultA = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignmentA.assignmentId,
        triggerRunId: 'trig-seg-a',
        sourceReference: caseA,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-01',
      },
      PRINCIPAL_VERA
    );
    expect(resultA.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(getScenarioStore('BLINKA-01').budgets.get('BUDGET-2026-10')?.committedUsd).toBe('2200');

    // Invoice B: seeded BLINKA-02 cloud vendor, exact 470 USD contract.
    const { assignment: assignmentB } = await service.createOrLoad(
      makeInboundCommand('evt-seg-b', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignmentB.caseId = caseB;
    await harnessStore.saveAssignment(assignmentB);
    const resultB = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignmentB.assignmentId,
        triggerRunId: 'trig-seg-b',
        sourceReference: caseB,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-02',
        envelopeId: envelopeIdB,
      },
      PRINCIPAL_VERA
    );
    expect(resultB.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(getScenarioStore('BLINKA-02').budgets.get('BUDGET-2026-10')?.committedUsd).toBe('470');

    // No PAID-equivalent language anywhere in the decision trail.
    expect(JSON.stringify([resultA, resultB])).not.toContain('PAID');
  });

  it('never lets a review-flagged invoice segment become finance-ready', async () => {
    const packetBytes = Buffer.from([INVOICE_A, CONTRACT_PAGE].join('\f'));
    const classification = classificationFor(2, [
      { category: 'invoice', pages: [1], needsReview: true },
      { category: 'contract', pages: [2] },
    ]);
    const reviewStorage = join(tmpdir(), `praeco-l3-review-${randomUUID()}`);
    const reviewL1 = await createL1({
      storageRoot: reviewStorage,
      now: () => '2026-10-17T12:00:00Z',
      extractor: new SegmentedLabelledTextExtractor({
        classification: new StaticSegmentClassificationSource([
          { sourceHashSha256: sha256(packetBytes), packet: classification },
        ]),
      }),
    });

    try {
      const reviewPort = new L1EvidencePortAdapter({ l1: reviewL1 });
      const evRef = await reviewPort.ingestSource(
        { bytes: packetBytes, channel: 'CHAT', mimeType: 'text/plain', displayName: 'review-packet.txt' },
        {
          principal: PRINCIPAL_VERA,
          assignmentId: 'asg-review',
          workerPrincipalId: 'worker-vera',
          workerVersionId: 'v1.0.0',
          runId: 'run-review',
          ownershipEpoch: 1,
        }
      );
      expect(evRef.envelopeIds).toHaveLength(1);
      await expect(reviewL1.reader.loadReady(DEMO_TENANT_ID, evRef.envelopeIds[0]!)).rejects.toThrow();
    } finally {
      await rm(reviewStorage, { recursive: true, force: true });
    }
  });
});
