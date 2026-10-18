import type {
  FinancialDecisionPort,
  ReconcilerTickReport,
  TenantId,
  TrustedPrincipal,
} from './types.js';
import type { HarnessStore } from './store.js';
import type { WorkflowRunner } from './workflow-runner.js';

export interface HarnessReconcilerOptions {
  store: HarnessStore;
  decisionPort: FinancialDecisionPort;
  workflowRunner: WorkflowRunner;
  defaultTenantId?: TenantId;
  cadenceMs?: number;
  now?: () => string;
  onL2OutboxDrain?: (tenantId: TenantId) => Promise<number>;
}

/**
 * HarnessReconciler (ADR-007 / L3 Contract Sec 5.1)
 *
 * Runs on a cadence (in-process timer for demo day, Trigger.dev scheduled task in production target)
 * owning three explicit recovery duties:
 * 1. Outbox draining: Drain undispatched outbox rows for L3 events and call trusted L2 outbox drain port if configured.
 * 2. Approval observation: Read L2 approval lifecycle state (derived expiry createdAt + 24h evaluated on read);
 *    for expired or resolved approvals, transition L3 assignments to COMPLETED and complete L3 waits.
 *    The Reconciler never writes or mutates L2 state directly.
 * 3. Wait completion fallback: Completes suspended waitpoints if synchronous completion failed or was lost.
 */
export class HarnessReconciler {
  private readonly store: HarnessStore;
  private readonly decisionPort: FinancialDecisionPort;
  private readonly workflowRunner: WorkflowRunner;
  private readonly defaultTenantId?: TenantId;
  private readonly cadenceMs: number;
  private readonly now: () => string;
  private readonly onL2OutboxDrain?: (tenantId: TenantId) => Promise<number>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HarnessReconcilerOptions) {
    this.store = options.store;
    this.decisionPort = options.decisionPort;
    this.workflowRunner = options.workflowRunner;
    this.defaultTenantId = options.defaultTenantId;
    this.cadenceMs = options.cadenceMs ?? 15_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onL2OutboxDrain = options.onL2OutboxDrain;
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  public start(): void {
    if (this.timer !== null) return;

    this.timer = setInterval(async () => {
      try {
        if (this.defaultTenantId) {
          await this.tick(this.defaultTenantId);
        }
      } catch (err) {
        // Log error silently without crashing the reconciler loop
        console.error('[HarnessReconciler] Periodic tick error:', err);
      }
    }, this.cadenceMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Deterministic tick execution for scheduled cadence and offline tests.
   */
  public async tick(tenantId?: TenantId): Promise<ReconcilerTickReport> {
    const targetTenantId = tenantId ?? this.defaultTenantId;
    if (!targetTenantId) {
      throw new Error('[HarnessReconciler] Tenant ID must be provided to tick() or configured as defaultTenantId');
    }

    const timestamp = this.now();
    let drainedOutboxCount = 0;
    let observedApprovalsCount = 0;
    let completedAssignmentsCount = 0;

    // 1. Duty 1: Outbox Draining
    const drainedL3Events = await this.store.drainOutbox(targetTenantId);
    drainedOutboxCount += drainedL3Events.length;

    if (this.onL2OutboxDrain) {
      try {
        const l2Count = await this.onL2OutboxDrain(targetTenantId);
        drainedOutboxCount += l2Count;
      } catch (err) {
        console.error('[HarnessReconciler] L2 outbox drain error:', err);
      }
    }

    // 2. Duty 2 & 3: Approval Observation & Wait Completion Fallback
    const suspendedAssignments = await this.store.findAssignmentsByState(
      targetTenantId,
      'WAITING_FOR_REVIEW'
    );

    const systemPrincipal: TrustedPrincipal = {
      tenantId: targetTenantId,
      principalId: `system-reconciler-${targetTenantId}`,
      roles: ['FinanceAdmin', 'Auditor'],
      bindingRevision: 'rev-1',
    };

    for (const assignment of suspendedAssignments) {
      if (!assignment.l2ApprovalRequestId) continue;

      try {
        // Read L2 approval lifecycle without mutating L2 directly
        const observation = await this.decisionPort.getApprovalStatus(
          assignment.l2ApprovalRequestId,
          systemPrincipal
        );

        if (!observation) continue;

        observedApprovalsCount++;

        // If resolution or expiration occurred, resume the assignment
        if (observation.status !== 'PENDING') {
          await this.workflowRunner.resumeAssignment(
            {
              assignmentId: assignment.assignmentId,
            },
            systemPrincipal
          );
          completedAssignmentsCount++;
        }
      } catch (err) {
        console.error(
          `[HarnessReconciler] Failed to observe/resume assignment ${assignment.assignmentId}:`,
          err
        );
      }
    }

    return {
      tenantId: targetTenantId,
      drainedOutboxCount,
      observedApprovalsCount,
      completedAssignmentsCount,
      timestamp,
    };
  }
}
