import { beforeEach, describe, expect, it, vi } from "vitest"

const boundary = vi.hoisted(() => ({
  actor: vi.fn(),
  configuration: vi.fn(),
  getStore: vi.fn(),
  revalidate: vi.fn(),
  store: { initialize: vi.fn(), list: vi.fn(), get: vi.fn(), rename: vi.fn() },
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth")>(),
  requireWorkspaceActor: boundary.actor,
}))
vi.mock("@/lib/auth-config", () => ({ getAuthConfiguration: boundary.configuration }))
vi.mock("@/db/connection", () => ({ getConversationStore: boundary.getStore }))
vi.mock("next/cache", () => ({ revalidatePath: boundary.revalidate }))
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => { throw new Error(`REDIRECT:${destination}`) },
}))

import {
  getWorkspaceConversation, getWorkspaceConversations,
  openWorkspaceConversation, renameWorkspaceConversation,
} from "@/lib/conversation-service"
import { WorkspaceAccessError } from "@/lib/auth"
import { WorkspaceMetadataError } from "@/lib/conversations"
import { openSpecialistConversation, renameConversation } from "@/actions/conversations"
import { GET as listApi } from "@/app/api/conversations/route"
import { GET as getApi } from "@/app/api/conversations/[chatId]/route"

const actor = { userId: "user_synthetic", tenantId: "org:synthetic", role: "member" }
const id = "00000000-0000-4000-8000-000000000001"
const row = {
  id, specialistId: "vera", profileVersion: 1, title: "Synthetic",
  preview: "No stored messages", createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z",
}

beforeEach(() => {
  vi.resetAllMocks()
  boundary.actor.mockResolvedValue(actor)
  boundary.configuration.mockReturnValue({ mode: "clerk" })
  boundary.getStore.mockReturnValue(boundary.store)
  boundary.store.list.mockResolvedValue([row])
  boundary.store.get.mockResolvedValue(row)
  boundary.store.initialize.mockResolvedValue([row])
  boundary.store.rename.mockResolvedValue(row)
})

describe("authenticated metadata boundary", () => {
  it("does not read any database for the public offline demo", async () => {
    boundary.configuration.mockReturnValue({ mode: "demo" })
    expect((await getWorkspaceConversations()).mode).toBe("demo")
    expect(boundary.actor).not.toHaveBeenCalled()
    expect(boundary.getStore).not.toHaveBeenCalled()
  })

  it("reads with authenticated scope and no initialization side effects", async () => {
    expect((await getWorkspaceConversations()).mode).toBe("persisted")
    expect(boundary.store.list).toHaveBeenCalledWith(actor)
    expect(boundary.store.initialize).not.toHaveBeenCalled()
    await getWorkspaceConversation(id)
    expect(boundary.store.get).toHaveBeenCalledWith(actor, id)
  })

  it("uses a fresh actor for another user's request", async () => {
    await getWorkspaceConversations()
    const other = { ...actor, userId: "user_other" }
    boundary.actor.mockResolvedValue(other)
    await getWorkspaceConversations()
    expect(boundary.store.list).toHaveBeenLastCalledWith(other)
  })

  it("never substitutes fake conversations when the configured database is down", async () => {
    boundary.store.list.mockRejectedValue(new Error("synthetic-private-connection"))
    const state = await getWorkspaceConversations()
    expect(state).toEqual({ mode: "unavailable", conversations: [], code: "DATABASE_UNAVAILABLE" })
    expect(JSON.stringify(state)).not.toContain("synthetic-private-connection")
  })

  it("rejects unauthenticated writes before accessing the database", async () => {
    boundary.actor.mockRejectedValue(new WorkspaceAccessError(401, "AUTHENTICATION_REQUIRED"))
    await expect(openWorkspaceConversation({ specialistId: "vera" })).rejects.toMatchObject({ status: 401 })
    expect(boundary.getStore).not.toHaveBeenCalled()
  })

  it.each([
    { specialistId: "unknown" },
    { specialistId: "vera", tenantId: "org:attacker" },
    { specialistId: "vera", userId: "user_attacker" },
    { specialistId: "vera", role: "FinanceAdmin" },
  ])("rejects unknown profiles or forged authority fields", async (input) => {
    await expect(openWorkspaceConversation(input)).rejects.toMatchObject({ code: "INVALID_CONVERSATION_INPUT" })
    expect(boundary.getStore).not.toHaveBeenCalled()
  })

  it("creates only the verified actor's stable specialist conversations", async () => {
    expect(await openWorkspaceConversation({ specialistId: "vera" })).toBe(id)
    expect(boundary.store.initialize).toHaveBeenCalledWith(actor)
  })

  it("requires ownership again on rename and treats an inaccessible ID as missing", async () => {
    boundary.store.rename.mockResolvedValue(null)
    await expect(renameWorkspaceConversation({ conversationId: id, title: "Renamed" }))
      .rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" })
    expect(boundary.store.rename).toHaveBeenCalledWith(actor, id, "Renamed")
  })
})

describe("direct API protection", () => {
  it("denies unauthenticated requests even without Proxy", async () => {
    boundary.actor.mockRejectedValue(new WorkspaceAccessError(401, "AUTHENTICATION_REQUIRED"))
    expect((await listApi()).status).toBe(401)
    expect(boundary.getStore).not.toHaveBeenCalled()
  })

  it("returns the same 404 for an unknown or inaccessible conversation", async () => {
    boundary.store.get.mockResolvedValue(null)
    const response = await getApi(new Request(`http://localhost/api/conversations/${id}`),
      { params: Promise.resolve({ chatId: id }) })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "CONVERSATION_NOT_FOUND" })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(boundary.store.get).toHaveBeenCalledWith(actor, id)
  })

  it("returns no-store responses and sanitized connection failures", async () => {
    expect((await listApi()).headers.get("Cache-Control")).toBe("no-store")
    boundary.store.list.mockRejectedValue(new Error("synthetic-private-connection"))
    const response = await listApi()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "DATABASE_UNAVAILABLE" })
  })
})

describe("server actions", () => {
  it("opens a specialist and refreshes navigation after a successful write", async () => {
    const form = new FormData()
    form.set("specialistId", "vera")
    await expect(openSpecialistConversation(form)).rejects.toThrow(`REDIRECT:/chats/${id}`)
    expect(boundary.revalidate).toHaveBeenCalledWith("/", "layout")
  })

  it("does not accept forged identity hidden fields", async () => {
    const form = new FormData()
    form.set("specialistId", "vera")
    form.set("tenantId", "org:attacker")
    await expect(openSpecialistConversation(form)).rejects.toThrow("REDIRECT:/?workspaceError=INVALID_CONVERSATION_INPUT")
    expect(boundary.store.initialize).not.toHaveBeenCalled()
  })

  it("redirects expired/revoked sessions back to sign-in", async () => {
    boundary.actor.mockRejectedValue(new WorkspaceAccessError(401, "AUTHENTICATION_REQUIRED"))
    const form = new FormData()
    form.set("specialistId", "vera")
    await expect(openSpecialistConversation(form)).rejects.toThrow("REDIRECT:/sign-in")
    expect(boundary.getStore).not.toHaveBeenCalled()
  })

  it("exposes a safe retry state when the schema is missing", async () => {
    boundary.getStore.mockImplementation(() => { throw new WorkspaceMetadataError("DATABASE_SCHEMA_MISSING") })
    const form = new FormData()
    form.set("conversationId", id)
    form.set("title", "Synthetic rename")
    await expect(renameConversation(form)).rejects.toThrow("REDIRECT:/?workspaceError=DATABASE_SCHEMA_MISSING")
  })
})
