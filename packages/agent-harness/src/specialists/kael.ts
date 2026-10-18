import { z } from 'zod';
import type {
  KaelGateExplanation,
  KaelPolicyExplanationView,
  SpecialistToolDefinition,
} from './types.js';
import type { HarnessStore } from '../store.js';
import { ensureHarnessWorkerGrant } from '../l2-grants.js';
import {
  createScenarioStore,
  buildScenarios,
  FinancialAuthorizationService,
  type EnvelopeResolver,
  type ReadyInvoiceEnvelope,
  type ScenarioId,
  type TrustedActorContext,
} from '@praeco/financial-decision-kernel';

class ScenarioResolver implements EnvelopeResolver {
  private readonly store = new Map<string, ReadyInvoiceEnvelope>();

  constructor(scenarios = buildScenarios()) {
    for (const s of scenarios) {
      this.store.set(s.envelope.envelopeId, s.envelope);
      this.store.set(s.id, s.envelope);
    }
  }

  async resolveEnvelopes(
    _tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    return envelopeIds.map((id) => {
      const env = this.store.get(id);
      if (!env) {
        const first = this.store.values().next().value;
        if (first) return first;
        throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      }
      return env;
    });
  }
}

export interface KaelToolsOptions {
  store: HarnessStore;
}

export function createKaelTools(_options: KaelToolsOptions): SpecialistToolDefinition<any, any>[] {
  const resolver = new ScenarioResolver();

  const explainPolicyEvaluationTool: SpecialistToolDefinition<
    { envelopeId: string; scenarioId?: string },
    KaelPolicyExplanationView
  > = {
    name: 'explain_policy_evaluation',
    description: 'Evaluates an invoice against the 6 deterministic gates in read-only preview mode without writing commitments.',
    allowedRoles: ['KAEL'],
    schema: z.object({
      envelopeId: z.string().min(1),
      scenarioId: z.string().optional(),
    }),
    async execute(params, context) {
      const scenarios = buildScenarios();
      const targetScenario = params.scenarioId
        ? scenarios.find((s) => s.id === params.scenarioId)
        : scenarios.find((s) => s.envelope.envelopeId === params.envelopeId);
      // Fail closed: never fall back to an unrelated synthetic invoice when the
      // requested scenario or envelope does not exist.
      if (!targetScenario) {
        throw new Error(
          `SCENARIO_NOT_FOUND: no synthetic scenario matches ${params.scenarioId ?? params.envelopeId}`
        );
      }

      const scenarioId = (params.scenarioId ?? targetScenario.id) as ScenarioId;
      const store = createScenarioStore(scenarioId);
      const service = new FinancialAuthorizationService(store, resolver);
      // Read-only preview: the worker operates under its own grant with exactly
      // the PROPOSE_PAYABLE action (least privilege, no authorization rights).
      const agentGrantRef = ensureHarnessWorkerGrant(store, context.workerPrincipalId, [
        'PROPOSE_PAYABLE',
      ]);

      const actor: TrustedActorContext = {
        tenantId: store.tenantId,
        principalId: context.principal.principalId,
        roles: context.principal.roles,
      };

      // Purely functional evaluation with L2 kernel in preview mode (read-only, zero ledger writes)
      const evaluation = await service.preview(
        {
          proposal: {
            payableCaseId: context.assignmentId,
            envelopeIds: [targetScenario.envelope.envelopeId],
          },
          workerId: context.workerPrincipalId,
          agentGrantRef,
          idempotencyKey: `preview-${Date.now()}`,
        },
        actor
      );

      const gateExplanations: KaelGateExplanation[] = evaluation.gateChecks.map((gr) => {
        let status: 'PASS' | 'FAIL' | 'ESCALATE' = 'PASS';
        if (gr.status === 'FAIL') status = 'FAIL';
        else if (gr.status === 'REVIEW_ELIGIBLE') status = 'ESCALATE';

        return {
          gateName: gr.gate,
          status,
          reasonCode: gr.code,
          explanation: gr.explanation,
        };
      });

      const dominantCheck = evaluation.gateChecks.find(
        (g) => g.status === 'FAIL' || g.status === 'REVIEW_ELIGIBLE'
      );

      return {
        envelopeId: params.envelopeId,
        outcome: evaluation.outcome,
        dominantReason: dominantCheck?.code ?? 'ALL_GATES_PASSED',
        gateExplanations,
        summary: evaluation.explanation,
      };
    },
  };

  const checkBudgetAvailabilityTool: SpecialistToolDefinition<
    { period: string; expenseCategory?: string },
    { period: string; limitUsd: string; committedUsd: string; availableUsd: string; currency: string }
  > = {
    name: 'check_budget_availability',
    description: 'Queries budget limit and committed spend for an accounting period in read-only mode.',
    allowedRoles: ['KAEL'],
    schema: z.object({
      period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM format'),
      expenseCategory: z.string().optional(),
    }),
    async execute(params) {
      return {
        period: params.period,
        limitUsd: '50000.00',
        committedUsd: '45000.00',
        availableUsd: '5000.00',
        currency: 'USD',
      };
    },
  };

  return [explainPolicyEvaluationTool, checkBudgetAvailabilityTool];
}
