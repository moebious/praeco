import { generateText, type LanguageModelUsage } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/chat/config", () => ({
  readChatConfiguration: () => ({
    OPENROUTER_API_KEY: "synthetic-only",
    OPENROUTER_MODEL: "synthetic/model",
    TRIGGER_PROJECT_REF: "proj_synthetic",
    TRIGGER_SECRET_KEY: "tr_dev_sk_synthetic",
  }),
  readModelConfiguration: () => ({
    OPENROUTER_API_KEY: "synthetic-only", OPENROUTER_MODEL: "synthetic/model",
  }),
}))

import { configuredModel, estimatedCallCost, loadModelCard, reportedStepUsage } from "@/lib/chat/model"
import { chatErrorMessage } from "@/lib/chat/presentation"
import { usdToNanos, nanosToUsd } from "@/lib/chat/contracts"

const card = {
  id: "synthetic/model",
  pricing: { prompt: "0.000002", completion: "0.00001" },
  supported_parameters: ["tools", "max_tokens"],
}
const usage: LanguageModelUsage = {
  inputTokens: 10, outputTokens: 3, totalTokens: 13,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  raw: { cost: 0.000012, prompt_tokens: 10, completion_tokens: 3 },
}
afterEach(() => vi.unstubAllGlobals())

describe("OpenRouter model, pricing and usage accounting", () => {
  it("uses exact decimal cost arithmetic and conservative rounding", () => {
    expect(nanosToUsd(usdToNanos("0.1") + usdToNanos("0.2"))).toBe("0.300000000")
    expect(usdToNanos("0.0000000001")).toBe(1n)
    expect(() => usdToNanos("-1")).toThrow("CHAT_COST_UNKNOWN")
    expect(() => usdToNanos("1e999")).toThrow("CHAT_COST_UNKNOWN")
  })

  it("loads only the explicitly selected current catalog card without inference", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [card] }))
    expect(await loadModelCard(card.id, fetcher)).toEqual(card)
    expect(fetcher.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models")
    await expect(loadModelCard("unlisted/model", fetcher)).rejects.toThrow("CHAT_NOT_CONFIGURED")
    const unsupported = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{
      ...card, supported_parameters: ["max_tokens"],
    }] }))
    await expect(loadModelCard(card.id, unsupported)).rejects.toThrow("CHAT_NOT_CONFIGURED")
  })

  it("bounds serialized model context before reserving any provider call", () => {
    expect(() => estimatedCallCost(card, [{ role: "user", content: "x".repeat(7000) }]))
      .toThrow("CHAT_CONTEXT_LIMIT")
  })

  it("uses the real SDK provider with fake HTTP, disables model fallback, and requests provider usage", async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({
        id: "gen_synthetic", model: card.id, provider: "SyntheticProvider",
        choices: [{ index: 0, message: { role: "assistant", content: "Synthetic response" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: 0.000012 },
      })
    }))
    const result = await generateText({
      model: configuredModel(), prompt: "Synthetic input", maxRetries: 0,
      experimental_telemetry: { isEnabled: false },
    })
    expect(result.text).toBe("Synthetic response")
    expect(requests[0].model).toBe(card.id)
    expect(requests[0].provider).toEqual({ allow_fallbacks: false, require_parameters: true })
    expect(requests[0].usage).toEqual({ include: true })
    expect(reportedStepUsage({
      usage: result.usage, providerMetadata: result.providerMetadata, modelId: card.id,
    }).summary.costUsd).toBe("0.000012000")
  })

  it("fails closed on missing reported cost and preserves raw usage before aggregation", () => {
    const result = reportedStepUsage({
      usage, providerMetadata: { openrouter: { provider: "Synthetic", usage: { cost: 0.000012 } } },
      modelId: card.id, responseId: "gen_synthetic",
    })
    expect(result.reported.usage).toEqual(usage.raw)
    expect(result.reported.generationId).toBe("gen_synthetic")
    expect(() => reportedStepUsage({ usage: { ...usage, raw: {} }, modelId: card.id }))
      .toThrow("CHAT_COST_UNKNOWN")
  })

  it("does not surface arbitrary provider internals to the chat UI", () => {
    expect(chatErrorMessage(new Error("secret-account-key and stack details"))).toContain("no hay reintentos")
    expect(chatErrorMessage(new Error("CHAT_COST_UNKNOWN"))).toContain("conciliarlo")
  })
})
