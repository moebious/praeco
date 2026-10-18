import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({
  actor: vi.fn(), conversation: vi.fn(), configure: vi.fn(), token: vi.fn(),
  startFactory: vi.fn(), loadFactory: vi.fn(), start: vi.fn(), load: vi.fn(),
  authorize: vi.fn(), attach: vi.fn(), session: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({ requireWorkspaceActor: mock.actor }))
vi.mock("@/lib/chat/config", () => ({
  readChatConfiguration: () => ({ TRIGGER_SECRET_KEY: "tr_dev_sk_synthetic" }),
}))
vi.mock("@/db/connection", () => ({
  getConversationStore: () => ({ get: mock.conversation }),
}))
vi.mock("@/db/chat-store", () => ({
  getChatStore: () => ({
    authorize: mock.authorize, attachSession: mock.attach, session: mock.session,
  }),
}))
vi.mock("ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("ai")>(),
  validateUIMessages: async ({ messages }: { messages: unknown[] }) => messages,
}))
vi.mock("@trigger.dev/sdk", () => ({
  configure: mock.configure,
  auth: { createPublicToken: mock.token },
}))
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: {
    createStartSessionAction: mock.startFactory,
    createLoadTranscriptAction: mock.loadFactory,
  },
  defaultStorage: { kind: "Trigger-default-storage" },
}))

import {
  bootstrapOwnedChat, loadOwnedTranscript, mintOwnedChatToken, startOwnedChat,
} from "@/lib/chat/control"
import { WorkspaceChatError } from "@/lib/chat/contracts"

const chatId = "00000000-0000-4000-8000-000000000001"
const bindingId = "00000000-0000-4000-8000-000000000002"
const actor = { tenantId: "org:synthetic", userId: "user_synthetic", role: "member" }

beforeEach(() => {
  vi.clearAllMocks()
  mock.actor.mockResolvedValue(actor)
  mock.conversation.mockResolvedValue({ id: chatId })
  mock.authorize.mockResolvedValue({ bindingId, sessionId: "session_synthetic" })
  mock.attach.mockResolvedValue(undefined)
  mock.session.mockResolvedValue("session_synthetic")
  mock.token.mockResolvedValue("scoped-synthetic-pat")
  mock.startFactory.mockReturnValue(mock.start)
  mock.loadFactory.mockReturnValue(mock.load)
  mock.start.mockResolvedValue({ sessionId: "session_synthetic", publicAccessToken: "scoped-synthetic-pat" })
  mock.load.mockResolvedValue({ messages: [], cursors: { lastOutEventId: "synthetic-cursor" } })
})

describe("server-owned Trigger chat session access", () => {
  it("does not call Trigger for anonymous users", async () => {
    mock.actor.mockRejectedValue(new WorkspaceChatError("CHAT_ACCESS_DENIED"))
    await expect(startOwnedChat({ chatId, bindingId })).rejects.toThrow("CHAT_ACCESS_DENIED")
    expect(mock.configure).not.toHaveBeenCalled()
    expect(mock.start).not.toHaveBeenCalled()
  })

  it("checks same-tenant user ownership before token, start, or transcript actions", async () => {
    mock.conversation.mockResolvedValue(null)
    for (const action of [
      startOwnedChat({ chatId, bindingId }),
      mintOwnedChatToken({ chatId }),
      loadOwnedTranscript({ chatId }),
    ]) await expect(action).rejects.toThrow("CHAT_ACCESS_DENIED")
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.token).not.toHaveBeenCalled()
    expect(mock.load).not.toHaveBeenCalled()
  })

  it.each([
    { chatId, bindingId, tenantId: "org:attacker" },
    { chatId, bindingId, userId: "user:attacker" },
    { chatId, bindingId, role: "FinanceAdmin" },
    { chatId, bindingId, clientData: { tenantId: "attacker" } },
  ])("rejects forged client identity, roles, and unknown authority fields", async (payload) => {
    await expect(startOwnedChat(payload)).rejects.toThrow("CHAT_INPUT_INVALID")
    expect(mock.start).not.toHaveBeenCalled()
  })

  it("accepts only the opaque binding returned for this owner when starting a session", async () => {
    await expect(startOwnedChat({ chatId, bindingId })).resolves.toMatchObject({
      sessionId: "session_synthetic",
    })
    expect(mock.start).toHaveBeenCalledWith({ chatId, clientData: { bindingId } })
    await expect(startOwnedChat({ chatId, bindingId: "00000000-0000-4000-8000-000000000099" }))
      .rejects.toThrow("CHAT_ACCESS_DENIED")
  })

  it("mints a short-lived token scoped to one authorized session only", async () => {
    await expect(mintOwnedChatToken({ chatId })).resolves.toBe("scoped-synthetic-pat")
    expect(mock.token).toHaveBeenCalledWith({
      scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
      expirationTime: "1m",
    })
  })

  it("does not create sessions merely to bootstrap an unused conversation", async () => {
    mock.authorize.mockResolvedValue({ bindingId, sessionId: null })
    await expect(bootstrapOwnedChat({ chatId })).resolves.toEqual({
      bindingId, messages: [], session: undefined, nextCursor: undefined,
    })
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.load).not.toHaveBeenCalled()
  })

  it("restores history and cursor before the browser resumes the session", async () => {
    const result = await bootstrapOwnedChat({ chatId })
    expect(result.bindingId).toBe(bindingId)
    expect(result.session).toMatchObject({ lastEventId: "synthetic-cursor" })
    expect(mock.load).toHaveBeenCalledWith({ chatId, before: undefined, limit: 50 })
  })

  it("does not replace a failed history read with an empty fake transcript", async () => {
    mock.load.mockRejectedValue(new Error("synthetic-private-provider-detail"))
    await expect(loadOwnedTranscript({ chatId })).rejects.toThrow("CHAT_UNAVAILABLE")
  })
})