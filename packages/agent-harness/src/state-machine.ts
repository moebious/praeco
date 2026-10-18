import type {
  Assignment,
  AssignmentState,
  TrustedExecutionContext,
} from './types.js';

export class HarnessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'HarnessError';
  }
}

/** Allowed transitions between lifecycle states */
export const ALLOWED_TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: [
    'WAITING_FOR_REVIEW',
    'COMPLETED',
    'FAILED_RECOVERABLE',
    'FAILED_TERMINAL',
    'CANCELLED',
  ],
  WAITING_FOR_REVIEW: ['RUNNING', 'COMPLETED', 'CANCELLED'],
  FAILED_RECOVERABLE: ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

export const TERMINAL_STATES: ReadonlySet<AssignmentState> = new Set([
  'COMPLETED',
  'FAILED_TERMINAL',
  'CANCELLED',
]);

export function isTerminalState(state: AssignmentState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Asserts that a transition from currentState to nextState is permitted.
 */
export function assertValidTransition(
  current: AssignmentState,
  next: AssignmentState
): void {
  if (current === next) {
    return; // No-op transition
  }
  if (isTerminalState(current)) {
    throw new HarnessError(
      'TERMINAL_STATE_CANNOT_TRANSITION',
      `Cannot transition assignment from terminal state ${current} to ${next}`
    );
  }
  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new HarnessError(
      'INVALID_STATE_TRANSITION',
      `Illegal assignment state transition from ${current} to ${next}. Allowed: ${allowed.join(', ')}`
    );
  }
}

/**
 * Validates execution fencing guards:
 * 1. Tenant boundary match.
 * 2. Monotonic version match (CAS guard).
 * 3. Monotonic ownership epoch match (fences superseded task runs).
 * 4. Active runId match (fences competing or stale workers).
 */
export function validateExecutionFencing(
  assignment: Assignment,
  context: TrustedExecutionContext,
  expectedVersion: number
): void {
  if (assignment.tenantId !== context.principal.tenantId) {
    throw new HarnessError(
      'CROSS_TENANT_ACCESS_DENIED',
      `Cross-tenant execution violation: assignment belongs to ${assignment.tenantId}, context is ${context.principal.tenantId}`
    );
  }

  if (isTerminalState(assignment.state)) {
    throw new HarnessError(
      'ASSIGNMENT_ALREADY_TERMINAL',
      `Assignment ${assignment.assignmentId} is already in terminal state ${assignment.state}`
    );
  }

  if (assignment.version !== expectedVersion) {
    throw new HarnessError(
      'STALE_ASSIGNMENT_VERSION',
      `Stale version CAS conflict for assignment ${assignment.assignmentId}: expected ${expectedVersion}, currently ${assignment.version}`
    );
  }

  if (assignment.ownershipEpoch !== context.ownershipEpoch) {
    throw new HarnessError(
      'STALE_OWNERSHIP_EPOCH',
      `Stale ownership epoch fencing violation: context epoch ${context.ownershipEpoch} does not match active assignment epoch ${assignment.ownershipEpoch}`
    );
  }

  if (assignment.activeRunId && assignment.activeRunId !== context.runId) {
    throw new HarnessError(
      'STALE_WORKER_RUN',
      `Stale worker run fencing violation: context runId ${context.runId} does not match active assignment run ${assignment.activeRunId}`
    );
  }
}
