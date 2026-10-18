import "server-only"

import { WorkspaceAccessError } from "@/lib/auth"
import { FinanceWorkspaceError, type FinanceErrorCode } from "@/lib/finance/contracts"

/**
 * HTTP translation for the payable routes. Errors are reduced to fixed codes:
 * no kernel message, storage path or identifier is ever echoed to the client.
 */

const STATUS_BY_CODE: Record<FinanceErrorCode, number> = {
  CASE_NOT_FOUND: 404,
  EVIDENCE_UNAVAILABLE: 503,
  EVIDENCE_NOT_READY: 409,
  ROLE_REQUIRED: 403,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_REQUEST_MISMATCH: 409,
  INVALID_IDEMPOTENCY_KEY: 400,
  INVALID_ACTION: 400,
  DECISION_REJECTED: 409,
}

/** Kernel failures that carry a stable, non-sensitive code of their own. */
const KERNEL_FAILURES: readonly { readonly match: string; readonly status: number; readonly code: string }[] = [
  { match: "UNAUTHORIZED_ROLE", status: 403, code: "ROLE_REQUIRED" },
  { match: "TENANT_ID_MISMATCH", status: 403, code: "TENANT_MISMATCH" },
  { match: "APPROVAL_EXPIRED", status: 409, code: "APPROVAL_EXPIRED" },
  { match: "APPROVAL_ALREADY_RESOLVED", status: 409, code: "APPROVAL_ALREADY_RESOLVED" },
  { match: "APPROVAL_STALE", status: 409, code: "APPROVAL_STALE" },
  { match: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", status: 409, code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" },
  { match: "APPROVAL_REQUEST_NOT_FOUND", status: 404, code: "APPROVAL_NOT_FOUND" },
  { match: "UNKNOWN_AGENT_GRANT", status: 503, code: "DECISION_UNAVAILABLE" },
  { match: "GRANT_WORKER_MISMATCH", status: 503, code: "DECISION_UNAVAILABLE" },
]

export interface FinanceFailure {
  readonly status: number
  readonly code: string
}

export function financeFailure(error: unknown): FinanceFailure {
  if (error instanceof WorkspaceAccessError) return { status: error.status, code: error.code }
  if (error instanceof FinanceWorkspaceError) {
    return { status: STATUS_BY_CODE[error.code], code: error.code }
  }
  const message = error instanceof Error ? error.message : ""
  const known = KERNEL_FAILURES.find((failure) => message.startsWith(failure.match))
  if (known) return { status: known.status, code: known.code }
  return { status: 503, code: "DECISION_UNAVAILABLE" }
}

export function financeJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export function financeRedirect(request: Request, path: string): Response {
  return Response.redirect(new URL(path, request.url), 303)
}

/**
 * Browsers always send `Origin` and `Sec-Fetch-Site` on a state-changing form
 * POST; a cross-site value is rejected. Non-browser callers (tests, curl) send
 * neither and hold no ambient cookie, so they are allowed.
 */
export function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false

  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

/** Accepts a JSON body or a form-encoded body (progressive-enhancement forms). */
export async function readCommandPayload(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = await request.json()
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const form = await request.formData()
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
}

export function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === "string" ? value : ""
}
