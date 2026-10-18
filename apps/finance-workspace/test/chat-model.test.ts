import { generateText, type LanguageModelUsage } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/chat/config", () => ({
  readChatConfiguration: () => ({
    OPENROUTER_API_KEY: "synthetic-not-a-key", OPENROUTER_MODEL: "synthetic/model",
    TRIGGER_SECRET_KEY: "tr_dev_sk_synthetic", TRIGGER_PROJECT_REF: "proj_synthetic",
  }),
  readModelConfiguration: () => ({
    OPENROUTER_API_KEY: "synthetic-not-a-key", OPENROUTER_MODEL: "synthetic/model",
  }),
}))

import { configuredModel, estimatedCallCost, loadModelCard, reportedStepUsage } from "@/lib/chat/model"
import { chatErrorMessage, presentChatMessages } from "@/lib/chat/presentation"
import { nanosToUsd, usdToNanos } from "@/lib/chat/contracts"

afterEach(() => { vi.unstubAllGlobals() })
const card = { id: "synthetic/model", pricing: { prompt: "0.000002", completion: "0.00001" },
  supported_parameters: ["tools", "max_tokens"] }
const usage: LanguageModelUsage = {
  inputTokens: 10, outputTokens: 3, totalTokens: 13,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  raw: { cost: 0.000012, prompt_tokens: 10, completion_tokens: 3 },
}

describe("exact inference accounting", () => {
  it("uses exact decimals and conservative sub-nanodollar rounding", () => {
    expect(nanosToUsd(usdToNanos("0.1") + usdToNanos("0.2"))).toBe("0.300000000")
    expect(usdToNanos("1e-7")).toBe(100n)
    expect(usdToNanos("0.0000000001")).toBe(1n)
  })
  it.each(["-1", "NaN", "Infinity", "1e999", "x", "0".repeat(100)])("rejects invalid costs without exposing them", (value) => {
    expect(() => usdToNanos(value)).toThrow("CHAT_COST_UNKNOWN")
  })
  it("keeps raw reported usage before aggregation, including reasoning/cache details", () => {
    const result = reportedStepUsage({ usage, modelId: card.id, responseId: "gen_synthetic" })
    expect(result.summary.costUsd).toBe("0.000012000")
    expect(result.reported.usage).toEqual(usage.raw)
    expect(result.reported.generationId).toBe("gen_synthetic")
  })
  it("fails closed on missing cost instead of substituting zero", () => {
    expect(() => reportedStepUsage({ usage: { ...usage, raw: {} }, modelId: card.id }))
      .toThrow("CHAT_COST_UNKNOWN")
  })
})

describe("explicit provider and catalog checks", () => {
  it("selects only the configured catalog model without fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [card] }))
    expect(await loadModelCard(card.id, fetcher)).toEqual(card)
    expect(fetcher.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models")
    await expect(loadModelCard("missing/model", fetcher)).rejects.toThrow("CHAT_NOT_CONFIGURED")
  })
  it("bounds context before reserving another call", () => {
    expect(() => estimatedCallCost(card, [{ role: "user", content: "x".repeat(7000) }]))
      .toThrow("CHAT_CONTEXT_LIMIT")
  })
  it("uses the real provider SDK with fake HTTP, including usage and routing controls", async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({
        id: "gen_synthetic", model: card.id, provider: "SyntheticProvider",
        choices: [{ index: 0, message: { role: "assistant", content: "Synthetic response" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: 0.000012 },
      })
    }))
    const result = await generateText({ model: configuredModel(), prompt: "Synthetic input", maxRetries: 0 })
    expect(result.text).toBe("Synthetic response")
    expect(reportedStepUsage({ usage: result.usage, providerMetadata: result.providerMetadata, modelId: card.id })
      .summary.costUsd).toBe("0.000012000")
    expect(requests[0].model).toBe(card.id)
    expect(requests[0].provider).toEqual({ allow_fallbacks: false, require_parameters: true })
    expect(requests[0].usage).toEqual({ include: true })
  })
})

describe("chat presentation", () => {
  it("renders real usage separately from financial budget and preserves source messages", () => {
    const messages = [{
      id: "synthetic", role: "assistant" as const, parts: [
        { type: "text" as const, text: "Synthetic response" },
        { type: "data-usage" as const, data: { model: card.id, provider: "Synthetic",
          costUsd: "0.000012000", inputTokens: 10, outputTokens: 3 } },
      ],
    }]
    const copy = structuredClone(messages)
    const result = presentChatMessages(messages, "kael")
    expect(result[0].author).toBe("kael")
    expect(JSON.stringify(result)).toContain("no presupuesto financiero")
    expect(messages).toEqual(copy)
  })
  it("never displays raw unknown errors or credentials", () => {
    expect(chatErrorMessage(new Error("synthetic-private-key"))).not.toContain("synthetic-private-key")
    expect(chatErrorMessage(new Error("CHAT_COST_UNKNOWN"))).toContain("bloquearon")
  })
})
