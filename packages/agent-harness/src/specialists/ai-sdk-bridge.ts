import type { z } from 'zod';
import { HarnessError } from '../state-machine.js';
import type {
  SpecialistRole,
  TrustedExecutionContext,
} from '../types.js';
import type {
  SpecialistExecutionResult,
  SpecialistLimits,
  SpecialistStepRecord,
  SpecialistToolDefinition,
} from './types.js';
import { DEFAULT_SPECIALIST_LIMITS } from './types.js';

/**
 * Compatible representation of a Vercel AI SDK tool definition.
 * Matches Vercel AI SDK (ai v5/v6/v7) CoreTool / tool() interface.
 */
export interface AiSdkTool<TParams = any, TResult = any> {
  readonly description: string;
  readonly parameters: z.ZodType<TParams>;
  readonly inputSchema?: z.ZodType<TParams>;
  execute(params: TParams, options?: { signal?: AbortSignal }): Promise<TResult>;
}

export type AiSdkToolMap = Record<string, AiSdkTool>;

/**
 * Adapts internal SpecialistToolDefinitions into standard Vercel AI SDK tool definitions.
 * Server context (tenant, principal, runId, epoch) is closed over securely and cannot
 * be altered or injected by the calling model.
 */
export function toAiSdkTools(
  tools: readonly SpecialistToolDefinition<any, any>[],
  context: TrustedExecutionContext
): AiSdkToolMap {
  const result: AiSdkToolMap = {};

  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      parameters: tool.schema,
      inputSchema: tool.schema,
      execute: async (params: unknown, options?: { signal?: AbortSignal }) => {
        if (options?.signal?.aborted) {
          throw new HarnessError('EXECUTION_ABORTED', `Execution of tool ${tool.name} was aborted`);
        }
        const parsed = tool.schema.safeParse(params);
        if (!parsed.success) {
          throw new HarnessError(
            'INVALID_TOOL_PARAMETERS',
            `Invalid parameters for tool ${tool.name}: ${parsed.error.message}`
          );
        }
        const stepContext: TrustedExecutionContext = {
          ...context,
          signal: options?.signal ?? context.signal,
        };
        return tool.execute(parsed.data, stepContext);
      },
    };
  }

  return result;
}

export interface AiSdkSpecialistStep {
  readonly toolName: string;
  readonly params: unknown;
}

export interface AiSdkSpecialistRunnerOptions {
  readonly limits?: Partial<SpecialistLimits>;
}

/**
 * Bounded Vercel AI SDK Specialist Runner.
 *
 * Runs bounded specialist tool loops using the Vercel AI SDK tool protocol:
 * 1. Offline deterministic execution via scripted / tool-calling sequence (ADR-007 delta #1).
 * 2. Strict bounds enforcement: maxSteps and timeoutMs to prevent infinite loops.
 * 3. In-flight abort signal cancellation and step-level race timeout.
 * 4. Audit trail: records step records with inputs, outputs, and elapsed durations.
 */
export class AiSdkSpecialistRunner {
  private readonly limits: SpecialistLimits;

  constructor(options?: AiSdkSpecialistRunnerOptions) {
    this.limits = {
      maxSteps: options?.limits?.maxSteps ?? DEFAULT_SPECIALIST_LIMITS.maxSteps,
      timeoutMs: options?.limits?.timeoutMs ?? DEFAULT_SPECIALIST_LIMITS.timeoutMs,
    };
  }

  /**
   * Executes a bounded tool loop against a Vercel AI SDK tool map.
   */
  async executeBoundedLoop(
    role: SpecialistRole,
    tools: AiSdkToolMap,
    steps: readonly AiSdkSpecialistStep[],
    context: TrustedExecutionContext
  ): Promise<SpecialistExecutionResult> {
    const startTime = Date.now();
    const history: SpecialistStepRecord[] = [];
    let finalOutput: Record<string, unknown> = {};

    for (let i = 0; i < steps.length; i++) {
      const stepNumber = i + 1;

      // 1. Max steps bound
      if (stepNumber > this.limits.maxSteps) {
        throw new HarnessError(
          'MAX_STEPS_EXCEEDED',
          `Specialist ${role} exceeded maximum step budget of ${this.limits.maxSteps} steps`
        );
      }

      // 2. Deadline bound
      const elapsed = Date.now() - startTime;
      const remainingMs = this.limits.timeoutMs - elapsed;
      if (remainingMs <= 0) {
        throw new HarnessError(
          'EXECUTION_DEADLINE_EXCEEDED',
          `Specialist ${role} exceeded wall-clock timeout deadline of ${this.limits.timeoutMs}ms (elapsed: ${elapsed}ms)`
        );
      }

      const step = steps[i]!;
      const tool = tools[step.toolName];
      if (!tool) {
        throw new HarnessError('TOOL_NOT_FOUND', `Tool ${step.toolName} not found in AI SDK tool map`);
      }

      const stepStart = Date.now();
      const abortController = new AbortController();
      let timeoutHandle: NodeJS.Timeout | undefined;

      const stepPromise = tool.execute(step.params, { signal: abortController.signal });

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
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      const durationMs = Date.now() - stepStart;

      const record: SpecialistStepRecord = {
        stepNumber,
        role,
        toolName: step.toolName,
        inputSummary: JSON.stringify(step.params),
        outputSummary: typeof output === 'object' ? JSON.stringify(output) : String(output),
        durationMs,
        timestamp: new Date().toISOString(),
      };

      history.push(record);

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
