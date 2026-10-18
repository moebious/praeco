import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, type NextFetchEvent } from "next/server"

const clerk = vi.hoisted(() => ({
  auth: vi.fn(),
  middleware: vi.fn(),
  options: vi.fn(),
  connection: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server-env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server-env")>(),
  prepareServerEnvironment: vi.fn(),
}))
vi.mock("@clerk/nextjs/server", () => ({
  auth: clerk.auth,
  clerkMiddleware: (
    handler: (auth: unknown, request: unknown) => unknown,
    options: () => unknown
  ) => {
    clerk.options.mockImplementation(options)
    return (request: unknown) => {
      clerk.middleware()
      return handler(clerk.auth, request)
    }
  },
}))
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  connection: clerk.connection,
}))
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`) },
}))

import { resolveAuthConfiguration, isPublicAuthRoute } from "@/lib/auth-config"
import { requireWorkspaceActor, requireWorkspacePageAccess } from "@/lib/auth"
import { GET } from "@/app/api/session/route"
import proxy from "@/proxy"

const publicKey = `pk_test_${Buffer.from("synthetic.clerk.accounts.dev$").toString("base64")}`
const secretKey = "sk_test_syntheticOnlyNotACredential"

function configureIdentity() {
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", publicKey)
  vi.stubEnv("CLERK_SECRET_KEY", secretKey)
}

function proxyRequest(path: string) {
  return proxy(new NextRequest(`http://localhost:3010${path}`), {} as NextFetchEvent)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "")
  vi.stubEnv("CLERK_SECRET_KEY", "")
  clerk.auth.mockResolvedValue({
    userId: null,
    orgId: null,
    redirectToSignIn: ({ returnBackUrl }: { returnBackUrl?: string } = {}) => {
      const destination = new URL("http://localhost:3010/sign-in")
      if (returnBackUrl) destination.searchParams.set("redirect_url", returnBackUrl)
      return Response.redirect(destination)
    },
  })
})

afterEach(() => vi.unstubAllEnvs())

describe("identity configuration", () => {
  it("keeps the no-key demo available without invoking Clerk", async () => {
    expect(resolveAuthConfiguration({}).mode).toBe("demo")
    expect(await requireWorkspacePageAccess()).toBe(false)
    expect(clerk.auth).not.toHaveBeenCalled()
    expect(clerk.connection).toHaveBeenCalled()
  })

  it("requires both development keys and never returns their values", () => {
    const configuration = resolveAuthConfiguration({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicKey,
      CLERK_SECRET_KEY: secretKey,
    })
    expect(configuration).toEqual({ mode: "clerk", missing: [], invalid: [] })
    expect(JSON.stringify(configuration)).not.toContain(secretKey)
    expect(JSON.stringify(configuration)).not.toContain(publicKey)
  })

  it.each([
    { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicKey },
    { CLERK_SECRET_KEY: secretKey },
    { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "invalid", CLERK_SECRET_KEY: secretKey },
    { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicKey, CLERK_SECRET_KEY: "sk_live_wrongEnvironment" },
  ])("fails closed for partial or malformed identity configuration", (source) => {
    expect(resolveAuthConfiguration(source).mode).toBe("unavailable")
  })

  it("does not treat login-like private paths as public", () => {
    expect(isPublicAuthRoute("/sign-in")).toBe(true)
    expect(isPublicAuthRoute("/sign-in/factor-one")).toBe(true)
    expect(isPublicAuthRoute("/sign-up/verify")).toBe(true)
    expect(isPublicAuthRoute("/sign-internal")).toBe(false)
    expect(isPublicAuthRoute("/api/session")).toBe(false)
  })
})

describe("request protection", () => {
  it("keeps the secret in the server environment instead of propagating a dynamic key", () => {
    configureIdentity()
    const options = clerk.options()
    expect(options.publishableKey).toBe(publicKey)
    expect(options).not.toHaveProperty("secretKey")
    expect(JSON.stringify(options)).not.toContain(secretKey)
  })

  it("does not authenticate the public offline demo", async () => {
    const response = await proxyRequest("/chats/caso-0142")
    expect(response?.status).toBe(200)
    expect(clerk.middleware).not.toHaveBeenCalled()
  })

  it("keeps liveness available with incomplete keys", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", secretKey)
    expect((await proxyRequest("/api/health"))?.status).toBe(200)
    expect(clerk.middleware).not.toHaveBeenCalled()
  })

  it("blocks the workspace and APIs when only one key is set", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", secretKey)
    const page = await proxyRequest("/chats/caso-0142")
    expect(page?.status).toBe(503)
    expect(page?.headers.get("Cache-Control")).toBe("no-store")
    expect(page?.headers.get("x-middleware-rewrite")).toBeNull()
    const body = await page?.text()
    expect(body).toContain("La autenticación está incompleta")
    expect(body).not.toContain(secretKey)
    const api = await proxyRequest("/api/session")
    expect(api?.status).toBe(503)
    expect(await api?.json()).toEqual({ error: "AUTHENTICATION_UNAVAILABLE" })
    expect(clerk.middleware).not.toHaveBeenCalled()
  })

  it("redirects a signed-out deep link to login while preserving its destination", async () => {
    configureIdentity()
    const response = await proxyRequest("/chats/caso-0142")
    const location = new URL(response!.headers.get("location")!)
    expect(location.pathname).toBe("/sign-in")
    expect(location.searchParams.get("redirect_url")).toBe("http://localhost:3010/chats/caso-0142")
  })

  it("rejects direct unauthenticated APIs instead of sending login HTML", async () => {
    configureIdentity()
    const response = await proxyRequest("/api/session")
    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({ error: "AUTHENTICATION_REQUIRED" })
    expect(response?.headers.get("Cache-Control")).toBe("no-store")
  })

  it("allows the sign-in/sign-up routes", async () => {
    configureIdentity()
    expect((await proxyRequest("/sign-in"))?.status).toBe(200)
    expect((await proxyRequest("/sign-up/verify"))?.status).toBe(200)
    expect(clerk.auth).not.toHaveBeenCalled()
  })

  it("allows signed-in requests", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({ userId: "user_synthetic", orgId: null })
    expect((await proxyRequest("/"))?.status).toBe(200)
  })
})

describe("server-side identity and direct data access", () => {
  it("never manufactures an authenticated actor in demo mode", async () => {
    const response = await GET()
    expect(response.status).toBe(503)
    expect(clerk.auth).not.toHaveBeenCalled()
  })

  it("rejects direct handler access even without Proxy", async () => {
    configureIdentity()
    expect((await GET()).status).toBe(401)
    await expect(requireWorkspaceActor()).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    })
  })

  it("derives a private tenant from the verified user, never from client input", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({ userId: "user_synthetic", orgId: null })
    expect(await requireWorkspaceActor()).toEqual({
      userId: "user_synthetic",
      tenantId: "user:user_synthetic",
      role: "member",
    })
  })

  it("uses verified organization membership without granting FinanceAdmin", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValue({
      userId: "user_synthetic", orgId: "org_synthetic", orgRole: "org:admin",
    })
    const response = await GET()
    expect(await response.json()).toEqual({
      authenticated: true,
      userId: "user_synthetic",
      tenantId: "org:org_synthetic",
      role: "member",
    })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("rechecks session validity on the next call after logout or expiry", async () => {
    configureIdentity()
    clerk.auth.mockResolvedValueOnce({ userId: "user_synthetic", orgId: null })
    expect((await GET()).status).toBe(200)
    expect((await GET()).status).toBe(401)
  })

  it("fails closed without leaking SDK errors or credentials", async () => {
    configureIdentity()
    clerk.auth.mockRejectedValue(new Error(`Provider failed: ${secretKey}`))
    const response = await GET()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(secretKey)
  })
})
