/**
 * Shared, dependency-light contracts for the kernel-served finance surface.
 *
 * This module is deliberately free of `server-only`, storage and `@praeco/*`
 * runtime imports: it holds error codes, the approval role and the safe view
 * shapes. Kernel records enter only as erased type imports, so nothing here
 * bundles the kernel into a client component.
 */

import { z } from "zod"
import type {
  FinancialDecisionRecord,
  FinancialEvaluation,
} from "@praeco/financial-decision-kernel"

/** The only role the L2 kernel accepts for resolving a human approval. */
export const FINANCE_ADMIN_ROLE = "FinanceAdmin"

/**
 * Synthetic principal used while no identity service is configured. Labelled as
 * synthetic on every surface: it is not an authenticated person and exists only
 * so the offline demo can exercise the approval lifecycle.
 */
export const SYNTHETIC_DEMO_PRINCIPAL_ID = "actor-sintetico-demo"
export const SYNTHETIC_DEMO_ACTOR_LABEL = "Actor sintético de demostración (FinanceAdmin)"

/** Server-side claim read from the configured identity provider. */
export const FINANCE_ROLES_CLAIM = "praecoRoles"

/** Idempotency keys are opaque, bounded and compare-free. */
export const idempotencyKeySchema: z.ZodType<string> = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/)

export const FINANCE_ERROR_CODES = [
  "CASE_NOT_FOUND",
  "EVIDENCE_UNAVAILABLE",
  "EVIDENCE_NOT_READY",
  "ROLE_REQUIRED",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_REQUEST_MISMATCH",
  "INVALID_IDEMPOTENCY_KEY",
  "INVALID_ACTION",
  "DECISION_REJECTED",
] as const

export type FinanceErrorCode = (typeof FINANCE_ERROR_CODES)[number]

export class FinanceWorkspaceError extends Error {
  constructor(readonly code: FinanceErrorCode) {
    super(code)
    this.name = "FinanceWorkspaceError"
  }
}

/**
 * Stable brand check that does **not** rely on class identity.
 *
 * Bundlers may evaluate a module more than once (Turbopack/RSC chunks), so an
 * error thrown by one copy fails `instanceof` against the copy that catches it.
 * The `name` set in the constructor plus a known error code is stable across
 * copies, so server error mapping never degrades into a generic 503.
 */
export function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}

export function isFinanceWorkspaceError(error: unknown): error is FinanceWorkspaceError {
  if (error instanceof FinanceWorkspaceError) return true
  if (!hasErrorName(error, "FinanceWorkspaceError")) return false
  const code = (error as { code?: unknown }).code
  return (
    typeof code === "string" &&
    (FINANCE_ERROR_CODES as readonly string[]).includes(code)
  )
}

/** Safe per-envelope projection of `summarize()`; never raw invoice or account data. */
export interface PayableEvidenceView {
  readonly envelopeId: string
  readonly processingStatus: string
  readonly verificationStatus: string | null
  readonly usdEquivalent: string | null
  readonly issues: readonly string[]
  /** True only for `READY_FOR_POLICY_EVALUATION`. */
  readonly ready: boolean
}

export interface PayableSourceView {
  readonly file: string
  readonly displayName: string
  readonly channel: string
  readonly role: "primary" | "context"
  readonly disposition: string
  readonly envelopes: readonly PayableEvidenceView[]
}

export interface PayableApprovalView {
  readonly approvalRequestId: string
  readonly status: string
  readonly unroundedUsd: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt: string | null
}

/** Everything the case page renders; decision records come from the kernel. */
export interface PayableCaseView {
  readonly caseId: string
  readonly scenarioId: string
  readonly title: string
  readonly summary: string
  readonly sources: readonly PayableSourceView[]
  readonly readyEnvelopeCount: number
  readonly decision: FinancialDecisionRecord | null
  readonly approval: PayableApprovalView | null
  readonly preview: FinancialEvaluation | null
  /** Present when L1 could not return usable evidence for this case. */
  readonly evidenceError: FinanceErrorCode | null
}
