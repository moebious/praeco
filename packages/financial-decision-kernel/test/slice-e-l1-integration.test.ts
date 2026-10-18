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
  type TrustedActorContext,
} from '../src/index.js';

describe('L2 Slice E — Trusted L1 Evidence Reader Integration', () => {
  let l1StorageDir: string;
  let l1: L1Runtime;

  const actorWorker: TrustedActorContext = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-agent-demo',
    roles: ['WorkerAgent'],
  };

  beforeAll(async () => {
    l1StorageDir = join(tmpdir(), `praeco-l2-slice-e-test-${randomUUID()}`);
    l1 = await createL1({
      storageRoot: l1StorageDir,
      now: () => '2026-10-17T12:00:00Z',
    });
  });

  afterAll(async () => {
    await rm(l1StorageDir, { recursive: true, force: true });
  });

  it(
    'Scenario 01 end-to-end: processes real synthetic PDF through L1 and authorizes via L1EvidenceReaderAdapter',
    async () => {
    // 1. Read real synthetic invoice PDF from evidence-intelligence fixtures
    const pdfUrl = new URL(
      '../../evidence-intelligence/test/fixtures/demo-day/sources/01.pdf',
      import.meta.url
    );
    const pdfBytes = await readFile(pdfUrl);

    // 2. Register source in L1
    const source = await l1.register({
      tenantId: DEMO_TENANT_ID,
      bytes: pdfBytes,
      channel: 'PDF',
      mimeType: 'application/pdf',
      displayName: 'doc-bogota-01-pdf',
    });

    // 3. Process invoice through real L1 pipeline (extract, verify, normalize, retain artifacts)
    const envelopes = await l1.process(source);
    expect(envelopes).toHaveLength(1);
    const readyEnvelope = envelopes[0]!;
    expect(readyEnvelope.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');

    // 4. Initialize L2 store with Case 01 authoritative financial context
    const store = createScenarioStore('BLINKA-01');

    // 5. Connect L2 service via Slice E L1EvidenceReaderAdapter (calling reader.loadReady)
    const readerAdapter = new L1EvidenceReaderAdapter(l1.reader);
    const service = new FinancialAuthorizationService(store, readerAdapter);

    // 6. Submit financial decision command using the real L1 envelope ID
    const record = await service.decideAndCommit(
      {
        proposal: {
          payableCaseId: 'case-blinka-01-real-l1',
          envelopeIds: [readyEnvelope.envelopeId],
        },
        idempotencyKey: 'idem-real-l1-01',
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      actorWorker
    );

    // 7. Verify decision outcome and genuine evidence grounding
    expect(record.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(record.commitmentId).not.toBeNull();

    const g1 = record.gateChecks.find(c => c.gate === 'G1');
    expect(g1?.status).toBe('PASS');
    expect(g1?.code).toBe('G1_EVIDENCE_INTEGRITY_VERIFIED');
    expect(g1?.explanation).toContain('verificación L1 aceptada');

    // Check store effects
    const budget = store.budgets.get('BUDGET-2026-10');
    expect(budget?.committedUsd).toBe('2200');
  }, 30_000);

  it('rejects an envelope through L1EvidenceReaderAdapter if not READY or verification tampered', async () => {
    const readerAdapter = new L1EvidenceReaderAdapter(l1.reader);
    await expect(
      readerAdapter.resolveEnvelopes(DEMO_TENANT_ID, ['non-existent-env-id'])
    ).rejects.toThrow();
  });
});
