import {
  createScenarioStore,
  FinancialAuthorizationService,
  runGoldenDemo,
  type EnvelopeResolver,
  type ReadyInvoiceEnvelope,
  type ScenarioDef,
} from '@praeco/financial-decision-kernel';
import { SqlCommitPort, SqlFinancialStore } from './index.js';
import type { GoldenDemoSummary } from '@praeco/financial-decision-kernel';

class DemoEnvelopeResolver implements EnvelopeResolver {
  private readonly envelopes = new Map<string, ReadyInvoiceEnvelope>();

  public register(envelope: ReadyInvoiceEnvelope) {
    this.envelopes.set(envelope.envelopeId, envelope);
  }

  public async resolveEnvelopes(
    tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    return envelopeIds.map(id => {
      const env = this.envelopes.get(id);
      if (!env || env.source.tenantId !== tenantId) {
        throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      }
      return env;
    });
  }
}

/**
 * Runs the eight canonical Blinka scenarios plus the HITL approval with the
 * authoritative SQL commit backend (ADR-003). Each scenario gets its own
 * authoritative budget row (DEMO-001 isolation) so ledgers are never shared
 * across scenarios.
 */
export async function runSqlGoldenDemo(
  databaseUrl: string
): Promise<{ summary: GoldenDemoSummary; store: SqlFinancialStore }> {
  const store = await SqlFinancialStore.connect(databaseUrl);
  const port = new SqlCommitPort(store);
  const summary = await runGoldenDemo({
    serviceForScenario: async (scenario: ScenarioDef) => {
      const scenarioStore = createScenarioStore(scenario.id);
      const budget = Array.from(scenarioStore.budgets.values()).find(b => b.period === '2026-10');
      if (budget) {
        budget.budgetId = `${budget.budgetId}#${scenario.id}`;
        await store.seedBudget({
          tenantId: scenarioStore.tenantId,
          budgetId: budget.budgetId,
          period: budget.period,
          limitUsd: budget.limitUsd,
        });
      }
      const resolver = new DemoEnvelopeResolver();
      resolver.register(scenario.envelope);
      return new FinancialAuthorizationService(scenarioStore, resolver, undefined, port);
    },
  });
  return { summary, store };
}

// Auto-run if executed directly.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required to run the authoritative SQL golden demo.');
    process.exit(1);
  }
  runSqlGoldenDemo(databaseUrl)
    .then(async ({ summary, store }) => {
      await store.close();
      if (summary.mismatched.length > 0) {
        console.error(`Golden set mismatch: ${summary.mismatched.join(', ')}`);
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Fatal SQL demo error:', err);
      process.exit(1);
    });
}
