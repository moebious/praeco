import {
  createScenarioStore,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  type EnvelopeResolver,
  type ReadyInvoiceEnvelope,
  type ScenarioId,
  type TrustedActorContext,
} from './index.js';
import { createSyntheticEnvelope } from './fixtures.js';
import { makeSyntheticAccount } from './scenarios.js';

class CliEnvelopeResolver implements EnvelopeResolver {
  private readonly store = new Map<string, ReadyInvoiceEnvelope>();

  public register(envelope: ReadyInvoiceEnvelope) {
    this.store.set(envelope.envelopeId, envelope);
  }

  public async resolveEnvelopes(
    tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    return envelopeIds.map(id => {
      const env = this.store.get(id);
      if (!env || env.source.tenantId !== tenantId) {
        throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      }
      return env;
    });
  }
}

interface ScenarioDef {
  id: ScenarioId;
  title: string;
  claim: string;
  expected: string;
  envelope: ReadyInvoiceEnvelope;
}

export function buildScenarios(): ScenarioDef[] {
  return [
    {
      id: 'BLINKA-01',
      title: 'Bogotá developer contractor',
      claim: 'USD 2,200 invoice',
      expected: 'AUTHORIZED_SIMULATED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-01',
        invoiceNumber: 'BOG-2026-10',
        taxId: 'CO-900.123.456-7',
        amount: '2200.00',
        currency: 'USD',
      }),
    },
    {
      id: 'BLINKA-02',
      title: 'Cloud SaaS recurring (+2.13% < 5%)',
      claim: 'USD 480 recurring (prior USD 470)',
      expected: 'AUTHORIZED_SIMULATED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-02',
        invoiceNumber: 'CLOUD-2026-10',
        taxId: 'US-CLOUD-SAAS-1',
        amount: '480.00',
        currency: 'USD',
      }),
    },
    {
      id: 'BLINKA-03',
      title: 'Mexico design agency above threshold',
      claim: 'MXN 76,000 = USD 3,800',
      expected: 'PENDING_HUMAN_APPROVAL',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-03',
        invoiceNumber: 'MEX-2026-10',
        taxId: 'MX-DESIGN-AGENCY',
        amount: '76000.00',
        currency: 'MXN',
      }),
    },
    {
      id: 'BLINKA-04',
      title: 'Argentina contractor bonus overage',
      claim: 'USD 1,950 vs contract USD 1,500',
      expected: 'BLOCKED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-04',
        invoiceNumber: 'ARG-2026-10',
        taxId: 'AR-CONTRACTOR-1',
        amount: '1950.00',
        currency: 'USD',
      }),
    },
    {
      id: 'BLINKA-05',
      title: 'Resubmitted duplicate of Bogotá invoice',
      claim: 'Same invoice number as Case 01',
      expected: 'BLOCKED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-05',
        invoiceNumber: 'BOG-2026-10',
        taxId: 'CO-900.123.456-7',
        amount: '2200.00',
        currency: 'USD',
      }),
    },
    {
      id: 'BLINKA-06',
      title: 'New Colombian beneficiary not allowlisted',
      claim: 'COP 2,400,000 = USD 600',
      expected: 'BLOCKED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-06',
        invoiceNumber: 'COP-NEW-2026-10',
        taxId: 'CO-UNKNOWN-999',
        amount: '2400000.00',
        currency: 'COP',
      }),
    },
    {
      id: 'BLINKA-07',
      title: 'Insufficient monthly budget',
      claim: 'USD 2,100 vs available USD 1,400',
      expected: 'BLOCKED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-07',
        invoiceNumber: 'BUDGET-2026-10',
        taxId: 'US-VENDOR-BUDGET',
        amount: '2100.00',
        currency: 'USD',
      }),
    },
    {
      id: 'BLINKA-08',
      title: 'Changed payment account in invoice',
      claim: 'USD 1,200 account differs from directory',
      expected: 'BLOCKED',
      envelope: createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-08',
        invoiceNumber: 'ACCOUNT-2026-10',
        taxId: 'US-VENDOR-ACCT',
        account: makeSyntheticAccount('1111222233'), // Changed account!
        amount: '1200.00',
        currency: 'USD',
      }),
    },
  ];
}

export async function runCliDemo() {
  console.log('\n========================================================================');
  console.log('  PRAECO — Autonomous Financial Decision Kernel (Reto Blinka 30X)');
  console.log('  Isolated Scenario Oracle Runner');
  console.log('========================================================================\n');

  const scenarios = buildScenarios();
  const workerActor: TrustedActorContext = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-agent-demo',
    roles: ['WorkerAgent'],
  };
  const cfoActor: TrustedActorContext = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'cfo-finance-admin',
    roles: ['FinanceAdmin'],
  };

  let pendingApprovalRequestId: string | null = null;
  let approvalService: FinancialAuthorizationService | null = null;

  for (const s of scenarios) {
    const store = createScenarioStore(s.id);
    const resolver = new CliEnvelopeResolver();
    resolver.register(s.envelope);
    const service = new FinancialAuthorizationService(store, resolver);

    const record = await service.decideAndCommit(
      {
        proposal: {
          payableCaseId: `case-${s.id.toLowerCase()}`,
          envelopeIds: [s.envelope.envelopeId],
        },
        idempotencyKey: `idem-cli-${s.id}`,
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      workerActor
    );

    const matchesExpected = record.outcome === s.expected;
    const outcomeEmoji =
      record.outcome === 'AUTHORIZED_SIMULATED'
        ? '✅ PAGÓ (AUTORIZADO)'
        : record.outcome === 'PENDING_HUMAN_APPROVAL'
        ? '⏳ ESCALÓ (PENDIENTE)'
        : '🛑 FRENÓ (BLOQUEADO)';

    console.log(`[${s.id}] ${s.title}`);
    console.log(`  Reclamo:    ${s.claim}`);
    console.log(`  Decisión:   ${outcomeEmoji}`);
    console.log(`  Esperado:   ${s.expected} ${matchesExpected ? '✓ MATCH' : '✗ MISMATCH'}`);
    console.log(`  Explicación: ${record.explanation}`);

    if (record.outcome === 'PENDING_HUMAN_APPROVAL') {
      pendingApprovalRequestId = record.approvalRequestId;
      approvalService = service;
    }
    console.log('------------------------------------------------------------------------');
  }

  // Demonstrate HITL approval for Case 03
  if (pendingApprovalRequestId && approvalService) {
    console.log('\n========================================================================');
    console.log('  DEMOSTRACIÓN HUMAN-IN-THE-LOOP (HITL): Aprobación de Caso 03');
    console.log('========================================================================');
    console.log(`Resolviendo solicitud de aprobación: ${pendingApprovalRequestId}`);
    console.log('Actor: CFO / FinanceAdmin autenticado');

    const approvedRecord = await approvalService.resolveApproval(
      {
        approvalRequestId: pendingApprovalRequestId,
        idempotencyKey: 'idem-cfo-resolution-cli',
        action: 'APPROVE',
      },
      cfoActor
    );

    console.log(`Resultado tras aprobación: ✅ ${approvedRecord.outcome}`);
    console.log(`Compromiso ID: ${approvedRecord.commitmentId}`);
    console.log(`Explicación:   ${approvedRecord.explanation}`);
    console.log('========================================================================\n');
  }
}

// Auto-run if executed directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  runCliDemo().catch(err => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}
