import { HarnessError } from '../state-machine.js';
import type {
  SpecialistRole,
  TrustedExecutionContext,
} from '../types.js';
import type {
  SpecialistExecutionResult,
  SpecialistLimits,
  SpecialistStepRecord,
} from './types.js';
import { DEFAULT_SPECIALIST_LIMITS } from './types.js';
import type { SpecialistToolRegistry } from './registry.js';

export interface SpecialistStepCommand {
  readonly toolName: string;
  readonly params: unknown;
}

export class BoundedSpecialistRunner {
  private readonly limits: SpecialistLimits;

  constructor(
    private readonly registry: SpecialistToolRegistry,
    limits?: Partial<SpecialistLimits>
  ) {
    this.limits = {
      maxSteps: limits?.maxSteps ?? DEFAULT_SPECIALIST_LIMITS.maxSteps,
      timeoutMs: limits?.timeoutMs ?? DEFAULT_SPECIALIST_LIMITS.timeoutMs,
    };
  }

  /**
   * Executes a bounded specialist step sequence.
   * Guarantees termination: throws MAX_STEPS_EXCEEDED or EXECUTION_DEADLINE_EXCEEDED
   * if execution bounds are violated.
   */
  async runSpecialistLoop(
    role: SpecialistRole,
    steps: readonly SpecialistStepCommand[],
    context: TrustedExecutionContext
  ): Promise<SpecialistExecutionResult> {
    const startTime = Date.now();
    const history: SpecialistStepRecord[] = [];
    let finalOutput: Record<string, unknown> = {};

    for (let i = 0; i < steps.length; i++) {
      const stepNumber = i + 1;

      // 1. Check max steps bound
      if (stepNumber > this.limits.maxSteps) {
        throw new HarnessError(
          'MAX_STEPS_EXCEEDED',
          `Specialist ${role} exceeded maximum step budget of ${this.limits.maxSteps} steps`
        );
      }

      // 2. Check deadline bound
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.limits.timeoutMs) {
        throw new HarnessError(
          'EXECUTION_DEADLINE_EXCEEDED',
          `Specialist ${role} exceeded wall-clock timeout deadline of ${this.limits.timeoutMs}ms (elapsed: ${elapsed}ms)`
        );
      }

      const step = steps[i]!;
      const stepStart = Date.now();

      // 3. Execute tool through registry with strict role-based access control
      const output = await this.registry.executeTool(
        step.toolName,
        role,
        step.params,
        context
      );

      const durationMs = Date.now() - stepStart;
      const stepRecord: SpecialistStepRecord = {
        stepNumber,
        role,
        toolName: step.toolName,
        inputSummary: JSON.stringify(step.params),
        outputSummary: typeof output === 'object' ? JSON.stringify(output) : String(output),
        durationMs,
        timestamp: new Date().toISOString(),
      };

      history.push(stepRecord);

      if (typeof output === 'object' && output !== null) {
        finalOutput = output as Record<string, unknown>;
      }
    }

    return {
      role,
      runId: context.runId,
      stepsExecuted: history.length,
      history,
      finalOutput,
    };
  }
}
