import "server-only"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { LanguageModelUsage, ModelMessage, ProviderMetadata } from "ai"
import { z } from "zod"
import { readModelConfiguration } from "@/lib/chat/config"
import {
  MAX_CONTEXT_BYTES, MAX_OUTPUT_TOKENS, nanosToUsd, usdToNanos, WorkspaceChatError,
  type UsageSummary,
} from "@/lib/chat/contracts"

const modelCard = z.object({
  id: z.string(),
  pricing: z.object({ prompt: z.string().max(80), completion: z.string().max(80) }),
  supported_parameters: z.array(z.string()),
})
export type ModelCard = z.infer<typeof modelCard>
let cached: { model: ModelCard; until: number } | undefined

export async function loadModelCard(modelId: string, fetcher: typeof fetch = fetch): Promise<ModelCard> {
  if (fetcher === fetch && cached?.model.id === modelId && cached.until > Date.now()) return cached.model
  try {
    const response = await fetcher("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000), redirect: "error",
    })
    if (!response.ok) throw new Error()
    const result = z.object({ data: z.array(z.unknown()) }).parse(await response.json())
    const selected = result.data.find((entry) =>
      typeof entry === "object" && entry !== null && "id" in entry && entry.id === modelId)
    const parsed = modelCard.parse(selected)
    if (!parsed.supported_parameters.includes("tools") ||
        !parsed.supported_parameters.includes("max_tokens")) throw new Error()
    usdToNanos(parsed.pricing.prompt)
    usdToNanos(parsed.pricing.completion)
    if (fetcher === fetch) cached = { model: parsed, until: Date.now() + 300_000 }
    return parsed
  } catch {
    throw new WorkspaceChatError("CHAT_NOT_CONFIGURED")
  }
}

export function estimatedCallCost(card: ModelCard, messages: ModelMessage[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength
  if (bytes > MAX_CONTEXT_BYTES || messages.length > 24) {
    throw new WorkspaceChatError("CHAT_CONTEXT_LIMIT")
  }
  // Conservative reservation, not a provider-side billing guarantee. The SDK's
  // actual reported cost replaces it; missing cost retains the hold and blocks.
  const inputBound = bytes + messages.length * 512 + 2_000
  return nanosToUsd(usdToNanos(card.pricing.prompt) * BigInt(inputBound) +
    usdToNanos(card.pricing.completion) * BigInt(MAX_OUTPUT_TOKENS))
}

export function configuredModel() {
  const configuration = readModelConfiguration()
  return createOpenRouter({
    apiKey: configuration.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
  })(configuration.OPENROUTER_MODEL, {
    usage: { include: true },
    reasoning: { effort: "low" },
    extraBody: { provider: { allow_fallbacks: false, require_parameters: true } },
  })
}

const usageRecord = z.record(z.string(), z.unknown())

export function reportedStepUsage(input: {
  usage: LanguageModelUsage
  providerMetadata?: ProviderMetadata
  modelId: string
  responseId?: string
}) {
  const raw = usageRecord.safeParse(input.usage.raw)
  const metadata = usageRecord.safeParse(input.providerMetadata?.openrouter)
  const providerUsage = usageRecord.safeParse(metadata.success ? metadata.data.usage : undefined)
  const cost = raw.success && raw.data.cost !== undefined ? raw.data.cost
    : providerUsage.success ? providerUsage.data.cost : undefined
  if ((typeof cost !== "number" && typeof cost !== "string") ||
      input.usage.inputTokens === undefined || input.usage.outputTokens === undefined) {
    throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
  }
  const provider = metadata.success && typeof metadata.data.provider === "string"
    ? metadata.data.provider.slice(0, 100) : "OpenRouter (upstream not reported)"
  const summary: UsageSummary = {
    model: input.modelId,
    provider,
    costUsd: nanosToUsd(usdToNanos(cost)),
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
  }
  const reported = {
    usage: raw.success ? raw.data : {},
    openrouterUsage: providerUsage.success ? providerUsage.data : {},
    model: input.modelId,
    generationId: input.responseId ?? null,
    provider,
  }
  if (JSON.stringify(reported).length > 8192) throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
  return { summary, reported }
}
