import "server-only"
import { stepCountIs, type ModelMessage, type streamText } from "ai"
import { getChatStore } from "@/db/chat-store"
import { readModelConfiguration } from "@/lib/chat/config"
import { MAX_OUTPUT_TOKENS, MAX_STEPS, safeChatError, type UsageSummary } from "@/lib/chat/contracts"
import { configuredModel, estimatedCallCost, loadModelCard, reportedStepUsage } from "@/lib/chat/model"
import { workspaceChatTools } from "@/lib/chat/tools"

function reportTurnFailure(stage: string, error: unknown) {
  const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name : "UnknownError"
  console.error("praeco_chat_failure", { stage, code: safeChatError(error).code, errorType })
}

export async function runChatTurn(input: {
  chatId: string
  bindingId: string
  requestId: string
  messages: ModelMessage[]
  signal: AbortSignal
  streamText: typeof streamText
  onUsage?: (usage: UsageSummary) => void
}) {
  const store = getChatStore()
  await store.context(input.chatId, input.bindingId)
  const configuration = readModelConfiguration()
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
        try {
          await store.context(input.chatId, input.bindingId)
        } catch (error) {
          reportTurnFailure("step-context", error)
          throw error
        }
        try {
          reservation = await store.reserve(input.chatId, `${input.requestId}:${stepNumber}`,
            configuration.OPENROUTER_MODEL, estimatedCallCost(card, messages))
        } catch (error) {
          reportTurnFailure("reserve", error)
          throw error
        }
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
      onError: async ({ error }) => {
        reportTurnFailure("stream", error)
        await unknown()
      },
      onAbort: async () => { await unknown() },
      onFinish: async () => { await unknown() },
    })
  } catch (error) {
    await unknown()
    throw safeChatError(error)
  }
}
