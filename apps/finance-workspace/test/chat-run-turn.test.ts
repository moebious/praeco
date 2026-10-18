import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LanguageModelUsage, ModelMessage, streamText } from "ai"

const ledger = vi.hoisted(() => ({
  context: vi.fn(), reserve: vi.fn(), complete: vi.fn(), unknown: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/db/chat-store", () => ({ getChatStore: () => ledger }))
vi.mock("@/lib/chat/config", () => ({
  readChatConfiguration: () => ({ OPENROUTER_MODEL: "synthetic/model" }),
  readModelConfiguration: () => ({
    OPENROUTER_API_KEY: "synthetic-only", OPENROUTER_MODEL: "synthetic/model",
  }),
}))
vi.mock("@/lib/chat/model", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat/model")>(),
  configuredModel: () => ({ synthetic: true }),
  loadModelCard: async () => ({
    id: "synthetic/model", pricing: { prompt: "0.000002", completion: "0.00001" },
    supported_parameters: ["tools", "max_tokens"],
  }),
}))

import { runChatTurn } from "@/lib/chat/run-turn"

interface Hooks {
  maxRetries: number
  maxOutputTokens: number
  abortSignal: AbortSignal
  prepareStep: (event: { stepNumber: number; messages: ModelMessage[] }) => Promise<unknown>
  onStepFinish: (event: { usage: LanguageModelUsage; response: { modelId: string; id: string } }) => Promise<void>
  onAbort: () => Promise<void>
  onError: (event: { error: unknown }) => Promise<void>
  onFinish: () => Promise<void>
}

const messages: ModelMessage[] = [{ role: "user", content: "Synthetic" }]
const usage: LanguageModelUsage = {
  inputTokens: 10, outputTokens: 3, totalTokens: 13,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 }, raw: { cost: 0.000012 },
}

beforeEach(() => {
  vi.resetAllMocks()
  ledger.context.mockResolvedValue({ id: "synthetic" })
  ledger.reserve.mockResolvedValue("reservation_synthetic")
})

async function hooks(signal = new AbortController().signal) {
  let captured: Hooks | undefined
  // The stand-in captures only the SDK hook surface used by this adapter.
  const managedStream = vi.fn((options: Hooks) => { captured = options; return {} })
  await runChatTurn({
    chatId: "synthetic", bindingId: "session_synthetic", requestId: "message_synthetic",
    messages, signal, streamText: managedStream as unknown as typeof streamText,
  })
  if (!captured) throw new Error("Missing stream options")
  return captured
}

describe("bounded managed model loop", () => {
  it("checks the session binding and reserves before each provider call, with no retry", async () => {
    const options = await hooks()
    expect(ledger.context).toHaveBeenCalledWith("synthetic", "session_synthetic")
    expect(options.maxRetries).toBe(0)
    expect(options.maxOutputTokens).toBe(1024)
    await options.prepareStep({ stepNumber: 0, messages })
    expect(ledger.reserve).toHaveBeenCalledWith("synthetic", "message_synthetic:0", "synthetic/model", expect.any(String))
  })
  it("records reported cost instead of a fixed token tariff", async () => {
    const options = await hooks()
    await options.prepareStep({ stepNumber: 0, messages })
    await options.onStepFinish({ usage, response: { modelId: "synthetic/model", id: "gen_synthetic" } })
    await options.onFinish()
    expect(ledger.complete).toHaveBeenCalledWith("reservation_synthetic",
      expect.objectContaining({ costUsd: "0.000012000" }), expect.objectContaining({ usage: usage.raw }))
    expect(ledger.unknown).not.toHaveBeenCalled()
  })
  it("retains a hold and stops when reported cost is missing", async () => {
    const options = await hooks()
    await options.prepareStep({ stepNumber: 0, messages })
    await expect(options.onStepFinish({ usage: { ...usage, raw: {} },
      response: { modelId: "synthetic/model", id: "gen_synthetic" } })).rejects.toThrow("CHAT_COST_UNKNOWN")
    expect(ledger.unknown).toHaveBeenCalledWith("reservation_synthetic")
    expect(ledger.complete).not.toHaveBeenCalled()
  })
  it("forwards Stop to the provider and reconciles abort as unknown, never free", async () => {
    const controller = new AbortController()
    const options = await hooks(controller.signal)
    await options.prepareStep({ stepNumber: 0, messages })
    controller.abort()
    expect(options.abortSignal.aborted).toBe(true)
    await options.onAbort()
    expect(ledger.unknown).toHaveBeenCalledWith("reservation_synthetic")
  })
  it("records a provider error without exposing its raw message or releasing a hold", async () => {
    const options = await hooks()
    await options.prepareStep({ stepNumber: 0, messages })
    const logger = vi.spyOn(console, "error").mockImplementation(() => {})
    await options.onError({ error: new Error("synthetic-provider-error") })
    expect(logger).toHaveBeenCalledWith("praeco_chat_failure", {
      stage: "stream", code: "CHAT_UNAVAILABLE", errorType: "Error",
    })
    expect(JSON.stringify(logger.mock.calls)).not.toContain("synthetic-provider-error")
    logger.mockRestore()
    expect(ledger.unknown).toHaveBeenCalledWith("reservation_synthetic")
  })
})
