import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server-env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server-env")>(),
  prepareServerEnvironment: vi.fn(),
}))
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null, orgId: null, sessionClaims: null })),
}))
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`)
  },
  notFound: () => {
    throw new Error("NOT_FOUND")
  },
}))

import { SidebarProvider } from "@/components/ui/sidebar"
import PayablesPage from "@/app/(workspace)/payables/page"
import PayableCasePage from "@/app/(workspace)/payables/[caseId]/page"
import { resolveFinanceAccess } from "@/lib/finance/access"
import { getFinanceRuntime } from "@/lib/finance/runtime"

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

let storageRoot = ""

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "praeco-finance-pages-"))
  vi.stubEnv("PRAECO_FINANCE_DEMO_ROOT", storageRoot)
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "")
  vi.stubEnv("CLERK_SECRET_KEY", "")
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(storageRoot, { recursive: true, force: true })
})

async function renderCase(caseId: string, financeError?: string) {
  const page = await PayableCasePage({
    params: Promise.resolve({ caseId }),
    searchParams: Promise.resolve(financeError ? { financeError } : {}),
  })
  return renderToStaticMarkup(createElement(SidebarProvider, null, page))
}

describe("payables page", () => {
  it("lists every synthetic case with its state", async () => {
    const html = renderToStaticMarkup(createElement(SidebarProvider, null, await PayablesPage()))

    for (const caseId of ["payable-01", "payable-03", "payable-09"]) {
      expect(html).toContain(caseId)
    }
    expect(html).toContain("sin decidir")
    expect(html).toContain("AUTHORIZED_SIMULATED")
    expect(html).toContain("Actor sintético de demostración")
    expect(html).toContain("no hay durabilidad entre procesos")
  })
})

describe("case page", () => {
  it("renders the kernel verdict, its gates and the approval actions", async () => {
    const access = await resolveFinanceAccess()
    await getFinanceRuntime().decide("payable-01", access.actor, "pages-case-01")
    await getFinanceRuntime().decide("payable-03", access.actor, "pages-case-03")

    const authorized = await renderCase("payable-01")
    expect(authorized).toContain("AUTHORIZED_SIMULATED")
    expect(authorized).toContain("G1_EVIDENCE_INTEGRITY_VERIFIED")
    expect(authorized).toContain("decisionId")

    const pending = await renderCase("payable-03")
    expect(pending).toContain("PENDING_HUMAN_APPROVAL")
    expect(pending).toContain("Aprobar solicitud")
    expect(pending).toContain("Rechazar solicitud")
    expect(pending).toContain("FinanceAdmin")
  })

  it("fails closed on incomplete evidence and offers no decide action", async () => {
    const html = await renderCase("payable-09")

    expect(html).toContain("Documento 09")
    expect(html).toContain("Sin evidencia lista de L1")
    expect(html).not.toContain("Evaluar y decidir")
    expect(html).not.toContain("Previsualizar decisión")
    expect(html).not.toContain("AUTHORIZED_SIMULATED")
  })

  it("surfaces a failed command without claiming anything was authorized", async () => {
    const html = await renderCase("payable-01", "INVALID_IDEMPOTENCY_KEY")

    expect(html).toContain("INVALID_IDEMPOTENCY_KEY")
    expect(html).toContain("No se registró ninguna autorización")
  })
})
