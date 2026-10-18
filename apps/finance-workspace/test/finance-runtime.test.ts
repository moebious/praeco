import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

/**
 * The real L1 pipeline (LiteParse + verification) runs once per case and takes
 * seconds per document offline; these are integration tests, so they get an
 * explicit budget instead of the 5s unit default.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

import { DEMO_TENANT_ID, type TrustedActorContext } from "@praeco/financial-decision-kernel"

import { FINANCE_ADMIN_ROLE, SYNTHETIC_DEMO_PRINCIPAL_ID } from "@/lib/finance/contracts"
import { createFinanceRuntime, type FinanceRuntime } from "@/lib/finance/runtime"

const SOURCES_ROOT = resolve(__dirname, "..", "fixtures", "payable-sources")

const financeAdmin: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID,
  principalId: SYNTHETIC_DEMO_PRINCIPAL_ID,
  roles: [FINANCE_ADMIN_ROLE],
}

/** Same tenant, but without the approval role. */
const workerWithoutRole: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID,
  principalId: "worker-agent-demo",
  roles: ["WorkerAgent"],
}

const temporaryRoots: string[] = []

async function createRuntime(): Promise<FinanceRuntime> {
  const storageRoot = await mkdtemp(join(tmpdir(), "praeco-finance-"))
  temporaryRoots.push(storageRoot)
  return createFinanceRuntime({ sourcesRoot: SOURCES_ROOT, storageRoot })
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("payable intake through the real L1 pipeline", () => {
  let runtime: FinanceRuntime
  beforeAll(async () => {
    runtime = await createRuntime()
  })

  it("projects only the safe summarize() fields", async () => {
    const view = await runtime.view("payable-01", financeAdmin)

    expect(view.evidenceError).toBeNull()
    expect(view.readyEnvelopeCount).toBe(1)
    const envelope = view.sources[0]?.envelopes[0]
    expect(envelope?.ready).toBe(true)
    expect(envelope?.processingStatus).toBe("READY_FOR_POLICY_EVALUATION")
    expect(envelope?.verificationStatus).toBe("ACCEPTED")
    expect(envelope?.usdEquivalent).toContain("2200")
    expect(envelope?.issues).toEqual([])
    // No raw invoice or account field may reach the view model.
    expect(Object.keys(envelope ?? {})).toEqual([
      "envelopeId",
      "processingStatus",
      "verificationStatus",
      "usdEquivalent",
      "issues",
      "ready",
    ])
    expect(JSON.stringify(view)).not.toContain("SYN-BOG-ACCOUNT-A")
  })

  it("marks a multi-source case: context documents carry no payable claim", async () => {
    const view = await runtime.view("payable-02", financeAdmin)

    const [invoice, context] = view.sources
    expect(invoice?.role).toBe("primary")
    expect(invoice?.disposition).toBe("INVOICE_OR_UNCERTAIN")
    expect(invoice?.envelopes).toHaveLength(1)
    expect(context?.role).toBe("context")
    expect(context?.disposition).toBe("SUPPLEMENTAL_CONTEXT")
    expect(context?.envelopes).toEqual([])
    expect(view.readyEnvelopeCount).toBe(1)
  })
})

describe("kernel decisions", () => {
  let runtime: FinanceRuntime
  beforeAll(async () => {
    runtime = await createRuntime()
  })

  it("authorizes a clean case and exposes the gate-by-gate rationale", async () => {
    const decision = await runtime.decide("payable-01", financeAdmin, "decide-case-01-key")

    expect(decision.outcome).toBe("AUTHORIZED_SIMULATED")
    expect(decision.commitmentId).not.toBeNull()
    const g1 = decision.gateChecks.find((check) => check.gate === "G1")
    expect(g1?.status).toBe("PASS")
    expect(g1?.code).toBe("G1_EVIDENCE_INTEGRITY_VERIFIED")
    expect(g1?.explanation).toContain("verificación L1 aceptada")
    expect(decision.gateChecks).toHaveLength(6)

    const view = await runtime.view("payable-01", financeAdmin)
    expect(view.decision?.decisionId).toBe(decision.decisionId)
  })

  it("previews without committing and still decides the same case afterwards", async () => {
    const preview = await runtime.preview("payable-02", financeAdmin)
    expect(preview.outcome).toBe("AUTHORIZED_SIMULATED")
    expect(runtime.latestDecision("payable-02")).toBeNull()

    const decision = await runtime.decide("payable-02", financeAdmin, "decide-case-02-key")
    expect(decision.outcome).toBe("AUTHORIZED_SIMULATED")
    expect(decision.commitmentId).not.toBeNull()
  })

  it("returns the identical decision for a repeated idempotency key", async () => {
    const first = await runtime.decide("payable-03", financeAdmin, "approval-case-03-seed")
    expect(first.outcome).toBe("PENDING_HUMAN_APPROVAL")
    expect(first.approvalRequestId).not.toBeNull()

    const replay = await runtime.decide("payable-03", financeAdmin, "approval-case-03-seed")
    expect(replay.decisionId).toBe(first.decisionId)
    expect(replay.outcome).toBe("PENDING_HUMAN_APPROVAL")
  })

  it("blocks a second command on the same invoice under a new key", async () => {
    const duplicate = await runtime.decide("payable-05", financeAdmin, "duplicate-case-05-key")
    expect(duplicate.outcome).toBe("BLOCKED")
    const g2 = duplicate.gateChecks.find((check) => check.gate === "G2")
    expect(g2?.status).toBe("FAIL")
    expect(g2?.code).toBe("G2_DUPLICATE")
  })

  it("fails closed on evidence that L1 never marks ready", async () => {
    const view = await runtime.view("payable-09", financeAdmin)
    expect(view.evidenceError).toBeNull()
    expect(view.readyEnvelopeCount).toBe(0)
    expect(view.sources[0]?.envelopes).toHaveLength(1)
    expect(view.sources[0]?.envelopes[0]?.ready).toBe(false)

    await expect(
      runtime.decide("payable-09", financeAdmin, "degraded-case-09-key")
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_READY" })
    expect(runtime.latestDecision("payable-09")).toBeNull()
  })

  it("rejects an idempotency key outside the accepted shape", async () => {
    await expect(
      runtime.decide("payable-01", financeAdmin, "short")
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" })
  })

  it("rejects unknown cases", async () => {
    await expect(runtime.view("payable-99", financeAdmin)).rejects.toMatchObject({
      code: "CASE_NOT_FOUND",
    })
  })
})

describe("human approval lifecycle", () => {
  let runtime: FinanceRuntime
  beforeAll(async () => {
    runtime = await createRuntime()
  })

  async function pendingApproval() {
    const decision = await runtime.decide("payable-03", financeAdmin, "approval-pending-03")
    expect(decision.outcome).toBe("PENDING_HUMAN_APPROVAL")
    const approvalRequestId = decision.approvalRequestId
    if (!approvalRequestId) throw new Error("missing approval request")
    return { decision, approvalRequestId }
  }

  it("refuses an actor without the FinanceAdmin role", async () => {
    const { approvalRequestId } = await pendingApproval()

    await expect(
      runtime.resolveApproval(
        "payable-03",
        { approvalRequestId, idempotencyKey: "resolve-without-role", action: "APPROVE" },
        workerWithoutRole
      )
    ).rejects.toMatchObject({ code: "ROLE_REQUIRED" })

    const view = await runtime.view("payable-03", financeAdmin)
    expect(view.approval?.status).toBe("PENDING")
  })

  it("authorizes once approved and replays the same decision for the same key", async () => {
    const { approvalRequestId } = await pendingApproval()

    const approved = await runtime.resolveApproval(
      "payable-03",
      { approvalRequestId, idempotencyKey: "resolve-approve-03", action: "APPROVE" },
      financeAdmin
    )
    expect(approved.outcome).toBe("AUTHORIZED_SIMULATED")
    expect(approved.commitmentId).not.toBeNull()
    const g6 = approved.gateChecks.find((check) => check.gate === "G6")
    expect(g6?.code).toBe("HUMAN_APPROVAL_GRANTED")

    const replay = await runtime.resolveApproval(
      "payable-03",
      { approvalRequestId, idempotencyKey: "resolve-approve-03", action: "APPROVE" },
      financeAdmin
    )
    expect(replay.decisionId).toBe(approved.decisionId)

    const view = await runtime.view("payable-03", financeAdmin)
    expect(view.approval?.status).toBe("APPROVED")
    expect(view.decision?.outcome).toBe("AUTHORIZED_SIMULATED")
  })

  it("blocks the case when the request is rejected", async () => {
    const separate = await createRuntime()
    const decision = await separate.decide("payable-03", financeAdmin, "approval-pending-reject")
    const approvalRequestId = decision.approvalRequestId
    if (!approvalRequestId) throw new Error("missing approval request")

    const rejected = await separate.resolveApproval(
      "payable-03",
      { approvalRequestId, idempotencyKey: "resolve-reject-03", action: "REJECT" },
      financeAdmin
    )
    expect(rejected.outcome).toBe("BLOCKED")
    expect(rejected.commitmentId).toBeNull()

    const view = await separate.view("payable-03", financeAdmin)
    expect(view.approval?.status).toBe("REJECTED")
  })

  it("does not find an approval request under another case", async () => {
    await expect(
      runtime.resolveApproval(
        "payable-04",
        { approvalRequestId: "appr-does-not-exist", idempotencyKey: "resolve-other-case", action: "APPROVE" },
        financeAdmin
      )
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" })
  })
})
