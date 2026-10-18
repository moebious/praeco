import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
/**
 * The repository keeps a real `.env.local`; it must not be able to turn these
 * routes into identity-configured mode, so the loader is neutralised and the
 * Clerk variables are pinned empty (explicit demo mode).
 */
vi.mock("@/lib/server-env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server-env")>(),
  prepareServerEnvironment: vi.fn(),
}))
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: null, orgId: null, sessionClaims: null })) }))
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`)
  },
}))

import { POST as previewRoute } from "@/app/api/payables/[caseId]/preview/route"
import { POST as decideRoute } from "@/app/api/payables/[caseId]/decide/route"
import { POST as approvalRoute } from "@/app/api/payables/[caseId]/approvals/[approvalRequestId]/route"
import { financeFailure } from "@/lib/finance/http"
import { getFinanceRuntime } from "@/lib/finance/runtime"

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

let storageRoot = ""

function post(
  path: string,
  body: unknown,
  options: { readonly json?: boolean; readonly origin?: string } = {}
) {
  const headers: Record<string, string> = {}
  if (options.json !== false) headers["content-type"] = "application/json"
  if (options.origin) headers.origin = options.origin
  return new Request(`http://localhost:3010${path}`, {
    method: "POST",
    headers,
    body: options.json === false ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
  })
}

const context = <T extends object>(params: T) => ({ params: Promise.resolve(params) })

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "praeco-finance-routes-"))
  vi.stubEnv("PRAECO_FINANCE_DEMO_ROOT", storageRoot)
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "")
  vi.stubEnv("CLERK_SECRET_KEY", "")
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(storageRoot, { recursive: true, force: true })
})

describe("POST /api/payables/[caseId]/preview", () => {
  it("answers with a read-only evaluation and commits nothing", async () => {
    const response = await previewRoute(post("/api/payables/payable-01/preview", {}), context({ caseId: "payable-01" }))

    expect(response.status).toBe(200)
    const body = (await response.json()) as { preview: { outcome: string; gateChecks: unknown[] } }
    expect(body.preview.outcome).toBe("AUTHORIZED_SIMULATED")
    expect(body.preview.gateChecks).toHaveLength(6)
    expect(getFinanceRuntime().latestDecision("payable-01")).toBeNull()
  })

  it("reports an unknown case without touching the ledger", async () => {
    const response = await previewRoute(post("/api/payables/payable-99/preview", {}), context({ caseId: "payable-99" }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "CASE_NOT_FOUND" })
  })
})

describe("POST /api/payables/[caseId]/decide", () => {
  it("commits once and replays the same decision for the same key", async () => {
    const request = () => post("/api/payables/payable-01/decide", { idempotencyKey: "route-decide-0001" })

    const first = await decideRoute(request(), context({ caseId: "payable-01" }))
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { decision: { decisionId: string; outcome: string } }
    expect(firstBody.decision.outcome).toBe("AUTHORIZED_SIMULATED")

    const replay = await decideRoute(request(), context({ caseId: "payable-01" }))
    const replayBody = (await replay.json()) as { decision: { decisionId: string } }
    expect(replayBody.decision.decisionId).toBe(firstBody.decision.decisionId)
  })

  it("rejects a malformed idempotency key", async () => {
    const response = await decideRoute(
      post("/api/payables/payable-01/decide", { idempotencyKey: "no" }),
      context({ caseId: "payable-01" })
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "INVALID_IDEMPOTENCY_KEY" })
  })

  it("rejects a cross-site request before reading anything", async () => {
    const response = await decideRoute(
      post("/api/payables/payable-01/decide", { idempotencyKey: "route-decide-0002" }, { origin: "https://evil.example" }),
      context({ caseId: "payable-01" })
    )
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "CROSS_ORIGIN_REJECTED" })
  })

  it("navigates a plain form back to the case page", async () => {
    const response = await decideRoute(
      post("/api/payables/payable-06/decide", { idempotencyKey: "route-form-0001" }, { json: false }),
      context({ caseId: "payable-06" })
    )
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("http://localhost:3010/payables/payable-06")

    const failure = await decideRoute(
      post("/api/payables/payable-06/decide", { idempotencyKey: "x" }, { json: false }),
      context({ caseId: "payable-06" })
    )
    expect(failure.status).toBe(303)
    expect(failure.headers.get("location")).toBe(
      "http://localhost:3010/payables/payable-06?financeError=INVALID_IDEMPOTENCY_KEY"
    )
  })
})

describe("POST /api/payables/[caseId]/approvals/[approvalRequestId]", () => {
  async function pendingApprovalId(): Promise<string> {
    const response = await decideRoute(
      post("/api/payables/payable-03/decide", { idempotencyKey: "route-approval-pending" }),
      context({ caseId: "payable-03" })
    )
    const body = (await response.json()) as { decision: { outcome: string; approvalRequestId: string | null } }
    expect(body.decision.outcome).toBe("PENDING_HUMAN_APPROVAL")
    if (!body.decision.approvalRequestId) throw new Error("missing approval request")
    return body.decision.approvalRequestId
  }

  it("authorizes the case after a human approval", async () => {
    const approvalRequestId = await pendingApprovalId()

    const response = await approvalRoute(
      post(`/api/payables/payable-03/approvals/${approvalRequestId}`, {
        action: "APPROVE",
        idempotencyKey: "route-approve-0001",
      }),
      context({ caseId: "payable-03", approvalRequestId })
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { decision: { outcome: string; commitmentId: string | null } }
    expect(body.decision.outcome).toBe("AUTHORIZED_SIMULATED")
    expect(body.decision.commitmentId).not.toBeNull()
  })

  it("rejects an unknown action and an unknown request", async () => {
    const badAction = await approvalRoute(
      post("/api/payables/payable-03/approvals/appr-unknown", { action: "PAY", idempotencyKey: "route-bad-0001" }),
      context({ caseId: "payable-03", approvalRequestId: "appr-unknown" })
    )
    expect(badAction.status).toBe(400)
    await expect(badAction.json()).resolves.toEqual({ error: "INVALID_ACTION" })

    const missing = await approvalRoute(
      post("/api/payables/payable-03/approvals/appr-unknown", { action: "APPROVE", idempotencyKey: "route-bad-0002" }),
      context({ caseId: "payable-03", approvalRequestId: "appr-unknown" })
    )
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: "APPROVAL_NOT_FOUND" })
  })
})

describe("financeFailure is identity-independent", () => {
  /**
   * Turbopack/RSC can evaluate `contracts.ts` in more than one chunk, so a
   * domain error thrown by one copy fails `instanceof` against the copy that
   * maps it. These decoys mimic that second copy: same `name`, different class.
   */
  class ForeignFinanceError extends Error {
    constructor(readonly code: string) {
      super(code)
      this.name = "FinanceWorkspaceError"
    }
  }

  class ForeignAccessError extends Error {
    constructor(readonly status: number, readonly code: string) {
      super(code)
      this.name = "WorkspaceAccessError"
    }
  }

  it("maps a domain error from another module copy to its real status", () => {
    expect(financeFailure(new ForeignFinanceError("CASE_NOT_FOUND"))).toEqual({
      status: 404,
      code: "CASE_NOT_FOUND",
    })
    expect(financeFailure(new ForeignFinanceError("EVIDENCE_NOT_READY"))).toEqual({
      status: 409,
      code: "EVIDENCE_NOT_READY",
    })
    expect(financeFailure(new ForeignFinanceError("ROLE_REQUIRED"))).toEqual({
      status: 403,
      code: "ROLE_REQUIRED",
    })
  })

  it("maps a workspace access error from another module copy", () => {
    expect(financeFailure(new ForeignAccessError(401, "AUTHENTICATION_REQUIRED"))).toEqual({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    })
  })

  it("still fails closed for an unknown code or an unrelated error", () => {
    expect(financeFailure(new ForeignFinanceError("NOT_A_REAL_CODE"))).toEqual({
      status: 503,
      code: "DECISION_UNAVAILABLE",
    })
    expect(financeFailure(new Error("boom"))).toEqual({
      status: 503,
      code: "DECISION_UNAVAILABLE",
    })
  })
})
