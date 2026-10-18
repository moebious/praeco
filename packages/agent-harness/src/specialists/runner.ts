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
      const remainingMs = this.limits.timeoutMs - elapsed;
      if (remainingMs <= 0) {
        throw new HarnessError(
          'EXECUTION_DEADLINE_EXCEEDED',
          `Specialist ${role} exceeded wall-clock timeout deadline of ${this.limits.timeoutMs}ms (elapsed: ${elapsed}ms)`
        );
      }

      const step = steps[i]!;
      const stepStart = Date.now();
      const abortController = new AbortController();
      let timeoutHandle: NodeJS.Timeout | undefined;

      const stepContext: TrustedExecutionContext = {
        ...context,
        signal: abortController.signal,
      };

      // 3. Execute tool through registry with strict role-based access control
      const stepPromise = this.registry.executeTool(
        step.toolName,
        role,
        step.params,
        stepContext
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(
            new HarnessError(
              'EXECUTION_DEADLINE_EXCEEDED',
              `Specialist ${role} exceeded wall-clock timeout deadline of ${this.limits.timeoutMs}ms during tool ${step.toolName}`
            )
          );
        }, remainingMs);
      });

      let output: unknown;
      try {
        output = await Promise.race([stepPromise, timeoutPromise]);
      } catch (err) {
        // The losing promise may settle after the deadline; swallow a late
        // rejection so it cannot surface as an unhandled rejection. Its side
        // effects may still complete: cancellation is cooperative.
        stepPromise.catch(() => {});
        throw err;
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      const durationMs = Date.now() - stepStart;
      const stepRecord: SpecialistStepRecord = {
        stepNumber,
        role,
        toolName: step.toolName,
        inputSummary: '(redacted)',
        outputSummary: '(redacted)',
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
