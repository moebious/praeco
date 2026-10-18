import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const clerk = vi.hoisted(() => ({ auth: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server-env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server-env")>(),
  prepareServerEnvironment: vi.fn(),
}))
vi.mock("@clerk/nextjs/server", () => ({ auth: clerk.auth }))
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`)
  },
}))

import { DEMO_TENANT_ID } from "@praeco/financial-decision-kernel"

import { WorkspaceAccessError } from "@/lib/auth"
import { resolveFinanceAccess } from "@/lib/finance/access"
import { FINANCE_ADMIN_ROLE, SYNTHETIC_DEMO_PRINCIPAL_ID } from "@/lib/finance/contracts"

const publicKey = `pk_test_${Buffer.from("synthetic.clerk.accounts.dev$").toString("base64")}`
const secretKey = "sk_test_syntheticOnlyNotACredential"

function configureIdentity() {
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", publicKey)
  vi.stubEnv("CLERK_SECRET_KEY", secretKey)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "")
  vi.stubEnv("CLERK_SECRET_KEY", "")
})

afterEach(() => vi.unstubAllEnvs())

describe("finance actor resolution", () => {
  it("uses the labelled synthetic FinanceAdmin while no identity is configured", async () => {
    const access = await resolveFinanceAccess()

    expect(access.synthetic).toBe(true)
    expect(access.canApprove).toBe(true)
    expect(access.actor.tenantId).toBe(DEMO_TENANT_ID)
    expect(access.actor.principalId).toBe(SYNTHETIC_DEMO_PRINCIPAL_ID)
    expect(access.actor.roles).toContain(FINANCE_ADMIN_ROLE)
    expect(access.actorLabel).toMatch(/sintético/i)
    // No browser state and no external call participate in demo mode.
    expect(clerk.auth).not.toHaveBeenCalled()
  })

  it("denies the approval role to a verified session without the claim", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({
      userId: "user_member",
      orgId: null,
      sessionClaims: { org_role: "org:member" },
    })

    const access = await resolveFinanceAccess()

    expect(access.synthetic).toBe(false)
    expect(access.canApprove).toBe(false)
    expect(access.actor.roles).toEqual([])
    expect(access.actor.principalId).toBe("user_member")
    expect(access.actor.tenantId).toBe(DEMO_TENANT_ID)
    expect(access.actorLabel).toMatch(/sin rol FinanceAdmin/i)
  })

  it("reads the FinanceAdmin role from server-side session claims only", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({
      userId: "user_admin",
      orgId: "org_1",
      sessionClaims: { praecoRoles: ["FinanceAdmin"] },
    })

    const access = await resolveFinanceAccess()

    expect(access.canApprove).toBe(true)
    expect(access.actor.roles).toEqual([FINANCE_ADMIN_ROLE])
    expect(access.actor.tenantId).toBe(DEMO_TENANT_ID)
  })

  it("ignores malformed role claims instead of trusting them", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({
      userId: "user_tricky",
      orgId: null,
      sessionClaims: { praecoRoles: [{ rol: "FinanceAdmin" }, 7, "FinanceAdmin"] },
    })

    const access = await resolveFinanceAccess()

    expect(access.actor.roles).toEqual([FINANCE_ADMIN_ROLE])
    expect(access.canApprove).toBe(true)
  })

  it("fails closed without a session", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({ userId: null, orgId: null, sessionClaims: null })

    await expect(resolveFinanceAccess()).rejects.toMatchObject({ status: 401 })
  })

  it("fails closed while identity keys are incomplete", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", publicKey)
    vi.stubEnv("CLERK_SECRET_KEY", "")

    const error = await resolveFinanceAccess().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WorkspaceAccessError)
    expect(error).toMatchObject({ status: 503 })
  })
})
