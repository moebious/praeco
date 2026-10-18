import "server-only"
import { stepCountIs, type ModelMessage, type streamText } from "ai"
import { getChatStore } from "@/db/chat-store"
import { readChatConfiguration } from "@/lib/chat/config"
import { MAX_OUTPUT_TOKENS, MAX_STEPS, safeChatError, type UsageSummary } from "@/lib/chat/contracts"
import { configuredModel, estimatedCallCost, loadModelCard, reportedStepUsage } from "@/lib/chat/model"
import { workspaceChatTools } from "@/lib/chat/tools"

export async function runChatTurn(input: {
  chatId: string
  sessionId: string
  requestId: string
  messages: ModelMessage[]
  signal: AbortSignal
  streamText: typeof streamText
  onUsage?: (usage: UsageSummary) => void
}) {
  const store = getChatStore()
  await store.context(input.chatId, input.sessionId)
  const configuration = readChatConfiguration()
  const card = await loadModelCard(configuration.OPENROUTER_MODEL)
  let reservation: string | undefined

  async function unknown() {
    if (reservation) {
      const pending = reservation
      reservation = undefined
      await store.unknown(pending)
    }
  }

  try {
    return input.streamText({
      model: configuredModel(),
      messages: input.messages,
      tools: workspaceChatTools,
      toolChoice: "auto",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: AbortSignal.any([input.signal, AbortSignal.timeout(45_000)]),
      experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      prepareStep: async ({ stepNumber, messages }) => {
        await store.context(input.chatId, input.sessionId)
        reservation = await store.reserve(input.chatId, `${input.requestId}:${stepNumber}`,
          configuration.OPENROUTER_MODEL, estimatedCallCost(card, messages))
        return {}
      },
      onStepFinish: async (step) => {
        if (!reservation) throw safeChatError(undefined)
        try {
          const { summary, reported } = reportedStepUsage({
            usage: step.usage,
            providerMetadata: step.providerMetadata,
            modelId: step.response.modelId ?? configuration.OPENROUTER_MODEL,
            responseId: step.response.id,
          })
          await store.complete(reservation, summary, reported)
          reservation = undefined
          input.onUsage?.(summary)
        } catch (error) {
          await unknown()
          throw safeChatError(error)
        }
      },
      onError: async () => { await unknown() },
      onAbort: async () => { await unknown() },
      onFinish: async () => { await unknown() },
    })
  } catch (error) {
    await unknown()
    throw safeChatError(error)
  }
}
