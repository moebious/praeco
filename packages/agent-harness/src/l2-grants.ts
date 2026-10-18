import {
  createScenarioStore,
  type WorkerCapabilityGrant,
} from '@praeco/financial-decision-kernel';

export type ScenarioStore = ReturnType<typeof createScenarioStore>;

/**
 * Registers (idempotently) a demo capability grant binding the given harness
 * worker to the L2 kernel's command surface. The kernel rejects commands whose
 * workerId is not the worker bound to the referenced grant, so every specialist
 * must operate under its own least-privilege grant instead of borrowing the
 * seeded demo worker grant.
 */
export function ensureHarnessWorkerGrant(
  store: ScenarioStore,
  workerPrincipalId: string,
  allowedActions: readonly ('PROPOSE_PAYABLE' | 'REQUEST_SIMULATED_AUTHORIZATION')[]
): string {
  const grantId = `grant-harness-${workerPrincipalId}`;
  const existing = store.grants.get(grantId);
  if (!existing) {
    const grant: WorkerCapabilityGrant = {
      grantId,
      grantRevisionId: `grant-rev-${workerPrincipalId}-1`,
      tenantId: store.tenantId,
      workerId: workerPrincipalId,
      perPayableLimitUsd: '2500.00',
      allowedActions: [...allowedActions],
    };
    store.grants.set(grantId, grant);
  } else {
    const merged = Array.from(new Set([...existing.allowedActions, ...allowedActions]));
    if (merged.length > existing.allowedActions.length) {
      existing.allowedActions = merged;
    }
  }
  return grantId;
}
