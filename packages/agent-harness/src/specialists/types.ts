import { z } from 'zod';
import type {
  FinancialOutcome,
  SpecialistRole,
  TrustedExecutionContext,
} from '../types.js';

export interface SpecialistLimits {
  /** Maximum number of tool execution steps in a single bounded loop */
  readonly maxSteps: number;
  /** Maximum wall-clock duration in milliseconds */
  readonly timeoutMs: number;
}

export const DEFAULT_SPECIALIST_LIMITS: SpecialistLimits = {
  maxSteps: 6,
  timeoutMs: 15_000,
};

export interface SpecialistToolDefinition<TParams, TResult> {
  readonly name: string;
  readonly description: string;
  readonly allowedRoles: readonly SpecialistRole[];
  readonly schema: z.ZodType<TParams>;
  execute(params: TParams, context: TrustedExecutionContext): Promise<TResult>;
}

export interface SpecialistStepRecord {
  readonly stepNumber: number;
  readonly role: SpecialistRole;
  readonly toolName: string;
  readonly inputSummary: string;
  readonly outputSummary: string;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface SpecialistExecutionResult {
  readonly role: SpecialistRole;
  readonly runId: string;
  readonly stepsExecuted: number;
  readonly history: readonly SpecialistStepRecord[];
  readonly finalOutput: Record<string, unknown>;
}

/**
 * Vera's structured evidence extraction view.
 * Redacts raw bank account numbers and confidential credentials.
 */
export interface VeraEvidenceView {
  readonly sourceId: string;
  readonly sourceHashSha256: string;
  readonly pipelineRunId: string;
  readonly sourceDisposition: 'INVOICE_OR_UNCERTAIN' | 'SUPPLEMENTAL_CONTEXT';
  readonly envelopes: ReadonlyArray<{
    readonly envelopeId: string;
    readonly processingStatus: 'READY_FOR_POLICY_EVALUATION' | 'REVIEW_REQUIRED' | 'REJECTED' | 'PROCESSING_FAILED';
    readonly currency?: string;
    readonly totalAmount?: string;
    readonly vendorTaxId?: string;
    readonly issueDate?: string;
    readonly dueDate?: string;
    readonly maskedAccount?: string;
  }>;
}

/**
 * Kael's policy evaluation and gate explanation view.
 */
export interface KaelGateExplanation {
  readonly gateName: string;
  readonly status: 'PASS' | 'FAIL' | 'ESCALATE';
  readonly reasonCode: string;
  readonly explanation: string;
}

export interface KaelPolicyExplanationView {
  readonly envelopeId: string;
  readonly outcome: FinancialOutcome;
  readonly dominantReason: string;
  readonly gateExplanations: readonly KaelGateExplanation[];
  readonly summary: string;
}

/**
 * Nova's proposal preparation and dispatch result.
 */
export interface NovaProposalDispatchResult {
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly decisionId: string;
  readonly outcome: FinancialOutcome;
  readonly approvalRequestId?: string;
  readonly explanation: string;
}
