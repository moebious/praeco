import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type {
  NovaProposalDispatchResult,
  SpecialistToolDefinition,
} from './types.js';
import type { HarnessStore } from '../store.js';
import { HarnessError } from '../state-machine.js';
import { ensureHarnessWorkerGrant } from '../l2-grants.js';
import { deriveL2IdempotencyKey, sha256Hex } from '../hashing.js';
import type { FinancialDecisionPort } from '../types.js';
import {
  FinancialAuthorizationService,
  createScenarioStore,
  buildScenarios,
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

export interface NovaToolsOptions {
  store: HarnessStore;
  decisionPort?: FinancialDecisionPort;
  authService?: FinancialAuthorizationService;
}

export function createNovaTools(options: NovaToolsOptions): SpecialistToolDefinition<any, any>[] {
  const fallbackResolver = new ScenarioResolver();

  const prepareFinancialIntentTool: SpecialistToolDefinition<
    {
      caseId: string;
      envelopeId: string;
      requestedBudgetId: string;
      scenarioId?: string;
    },
    { intentId: string; idempotencyKey: string; payloadDigest: string }
  > = {
    name: 'prepare_financial_intent',
    description: 'Freezes an immutable FinancialIntentReference before L2 dispatch.',
    allowedRoles: ['NOVA'],
    schema: z.object({
      caseId: z.string().min(1),
      envelopeId: z.string().min(1),
      requestedBudgetId: z.string().min(1),
      scenarioId: z.string().optional(),
    }),
    async execute(params, context) {
      const tenantId = context.principal.tenantId;

      if (!params.envelopeId || params.envelopeId.trim() === '') {
        throw new HarnessError(
          'NO_READY_INVOICE',
          'Cannot prepare financial intent without a valid envelope ID'
        );
      }

      // 1. Verify case exists and is not supplemental-only
      const currentCase = await options.store.getCase(tenantId, params.caseId);
      const caseVersion = currentCase?.version ?? 1;

      if (currentCase && currentCase.sourceLinks.length > 0) {
        const docLinks = currentCase.sourceLinks.filter((l) => l.kind === 'DOCUMENT');
        const hasInvoice = docLinks.some(
          (l) => l.kind === 'DOCUMENT' && l.evidence.sourceDisposition === 'INVOICE_OR_UNCERTAIN'
        );
        if (docLinks.length > 0 && !hasInvoice) {
          throw new HarnessError(
            'NO_READY_INVOICE',
            'Cannot prepare financial intent for supplemental-only evidence'
          );
        }
      }

      // 2. Derive stable idempotency key and payload digest
      const canonicalKey = `CANONICAL:${params.envelopeId.toUpperCase()}`;
      const payloadDigest = sha256Hex(
        `${tenantId}:${params.caseId}:${params.envelopeId}:${params.requestedBudgetId}`
      );
      const idempotencyKey = deriveL2IdempotencyKey(tenantId, canonicalKey, payloadDigest);

      const intentId = `intent-${randomUUID()}`;
      const intent = {
        intentId,
        assignmentId: context.assignmentId,
        caseId: params.caseId,
        caseVersion,
        requestedByPrincipalId: context.principal.principalId,
        workerPrincipalId: context.workerPrincipalId,
        requestedBudgetId: params.requestedBudgetId,
        envelopeIds: [params.envelopeId] as readonly [string, ...string[]],
        idempotencyKey,
        payloadDigest,
      };

      await options.store.saveFinancialIntent(intent);

      return {
        intentId,
        idempotencyKey,
        payloadDigest,
      };
    },
  };

  const submitFinancialProposalTool: SpecialistToolDefinition<
    { intentId: string; scenarioId?: string },
    NovaProposalDispatchResult
  > = {
    name: 'submit_financial_proposal',
    description: 'Dispatches a frozen financial intent to L2 for deterministic authorization commit.',
    allowedRoles: ['NOVA'],
    schema: z.object({
      intentId: z.string().min(1),
      scenarioId: z.string().optional(),
    }),
    async execute(params, context) {
      const tenantId = context.principal.tenantId;

      // 1. Load frozen intent
      const intent = await options.store.getFinancialIntent(tenantId, params.intentId);
      if (!intent) {
        throw new HarnessError(
          'INTENT_NOT_FOUND',
          `Financial intent ${params.intentId} not found in store`
        );
      }

      // 2. Check if decision already committed for this intent (reconciliation on retry)
      const existingReceipt = await options.store.getCommandReceipt(
        tenantId,
        'FINANCIAL_INTENT',
        intent.idempotencyKey
      );
      if (existingReceipt) {
        const existingDecision = await options.store.getFinancialDecision(
          tenantId,
          existingReceipt.resultRef
        );
        if (existingDecision) {
          return {
            intentId: intent.intentId,
            idempotencyKey: intent.idempotencyKey,
            decisionId: existingDecision.decisionId,
            outcome: existingDecision.outcome,
            approvalRequestId: existingDecision.approvalRequestId,
            explanation: `Resultado ya registrado previamente (reconciliado por idempotencia).`,
          };
        }
      }

      let decisionRef;

      // 3. Dispatch through FinancialDecisionPort if provided
      if (options.decisionPort) {
        // Also check if L2 decision store already has this command result
        const observation = await options.decisionPort.getCommandResult(
          intent,
          context,
          params.scenarioId
        );
        if (observation.status === 'COMPLETED') {
          decisionRef = observation.decision;
        } else {
          decisionRef = await options.decisionPort.decideAndCommit(
            intent,
            context,
            params.scenarioId
          );
        }
      } else {
        // Fallback scenario resolution
        const scenarios = buildScenarios();
        const targetScenario = params.scenarioId
          ? scenarios.find((s) => s.id === params.scenarioId)
          : scenarios.find((s) => s.envelope.envelopeId === intent.envelopeIds[0]);
        // Fail closed: never fall back to an unrelated synthetic invoice when the
        // referenced scenario or envelope does not exist.
        if (!targetScenario) {
          throw new Error(
            `SCENARIO_NOT_FOUND: no synthetic scenario matches ${params.scenarioId ?? intent.envelopeIds[0]}`
          );
        }

        const scenarioId = (params.scenarioId ?? targetScenario.id) as ScenarioId;
        const scenarioStore = createScenarioStore(scenarioId);
        const service =
          options.authService ??
          new FinancialAuthorizationService(scenarioStore, fallbackResolver);
        // Nova requests simulated authorization: the worker operates under its
        // own grant carrying exactly the REQUEST_SIMULATED_AUTHORIZATION action.
        const agentGrantRef = ensureHarnessWorkerGrant(service.store, context.workerPrincipalId, [
          'REQUEST_SIMULATED_AUTHORIZATION',
        ]);

        const actor: TrustedActorContext = {
          tenantId: scenarioStore.tenantId,
          principalId: context.principal.principalId,
          roles: context.principal.roles,
        };

        const record = await service.decideAndCommit(
          {
            proposal: {
              payableCaseId: intent.caseId,
              envelopeIds: [targetScenario.envelope.envelopeId],
            },
            workerId: context.workerPrincipalId,
            agentGrantRef,
            idempotencyKey: intent.idempotencyKey,
          },
          actor
        );

        decisionRef = {
          decisionId: record.decisionId,
          outcome: record.outcome,
          approvalRequestId: record.approvalRequestId ?? undefined,
          gateSummaryRefs: record.gateChecks.map((g) => `${g.gate}:${g.status}`),
        };
      }

      // 4. Record decision reference in store
      await options.store.saveFinancialDecision(tenantId, decisionRef);

      // 5. Persist command receipt to guarantee idempotency on retries
      await options.store.saveCommandReceipt({
        commandReceiptId: `cr-${randomUUID()}`,
        tenantId,
        scope: 'FINANCIAL_INTENT',
        commandKey: intent.idempotencyKey,
        payloadDigest: intent.payloadDigest,
        resultRef: decisionRef.decisionId,
        createdAt: new Date().toISOString(),
      });

      return {
        intentId: intent.intentId,
        idempotencyKey: intent.idempotencyKey,
        decisionId: decisionRef.decisionId,
        outcome: decisionRef.outcome,
        approvalRequestId: decisionRef.approvalRequestId,
        explanation: `Decisión L2 procesada: ${decisionRef.outcome}`,
      };
    },
  };

  return [prepareFinancialIntentTool, submitFinancialProposalTool];
}
