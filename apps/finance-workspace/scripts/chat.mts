import { randomUUID } from "node:crypto"
import { configure, auth, sessions } from "@trigger.dev/sdk"
import { chat, defaultStorage } from "@trigger.dev/sdk/ai"
import { TriggerChatTransport } from "@trigger.dev/sdk/chat"
import { drizzle } from "drizzle-orm/node-postgres"
import { createWorkspacePool } from "../db/connection"
import { createConversationStore } from "../db/conversation-store"
import { createChatStore } from "../db/chat-store"
import * as schema from "../db/schema"
import { readChatConfiguration } from "../lib/chat/config"
import { loadModelCard } from "../lib/chat/model"
import {
  CHAT_TASK_ID, CHAT_TOKEN_TTL, nanosToUsd, usdToNanos, WorkspaceChatError,
} from "../lib/chat/contracts"

const command = process.argv[2]

async function main() {
  const configuration = readChatConfiguration()
  configure({ secretKey: configuration.TRIGGER_SECRET_KEY, baseURL: "https://api.trigger.dev" })
  const card = await loadModelCard(configuration.OPENROUTER_MODEL)
  if (command === "status") {
    console.log(JSON.stringify({
      model: card.id, promptUsdPerToken: card.pricing.prompt,
      completionUsdPerToken: card.pricing.completion,
      supportsTools: card.supported_parameters.includes("tools"),
      triggerDevelopmentConfigured: true, catalogOnly: true,
    }))
    return
  }
  if (command !== "smoke" || !process.argv.includes("--allow-paid") ||
      !process.argv.includes("--budget-usd=0.05") || !process.argv.includes("--max-calls=3")) {
    throw new Error("CHAT_SMOKE_REQUIRES_EXPLICIT_LIMITS")
  }
  const pool = createWorkspacePool()
  const db = drizzle(pool, { schema })
  const metadata = createConversationStore(db)
  const store = createChatStore(db)
  const scope = { tenantId: `smoke:${randomUUID()}`, userId: `smoke:${randomUUID()}` }
  let id: string | undefined
  let sessionId: string | undefined
  try {
    const rows = await metadata.initialize(scope)
    const conversation = rows.find((row) => row.specialistId === "vera")
    if (!conversation) throw new Error("CHAT_SMOKE_SETUP_FAILED")
    id = conversation.id
    const lease = await store.authorize(scope, id, 3)
    const start = chat.createStartSessionAction(CHAT_TASK_ID, { tokenTTL: CHAT_TOKEN_TTL })
    const transport = new TriggerChatTransport({
      task: CHAT_TASK_ID,
      accessToken: async () => {
        const refreshedLease = await store.authorize(scope, conversation.id, 3)
        if (refreshedLease.bindingId !== lease.bindingId) throw new Error("CHAT_SMOKE_SETUP_FAILED")
        return auth.createPublicToken({
          scopes: { read: { sessions: conversation.id }, write: { sessions: conversation.id } },
          expirationTime: CHAT_TOKEN_TTL,
        })
      },
      startSession: async () => {
        const result = await start({
          chatId: conversation.id, clientData: { bindingId: lease.bindingId },
        })
        sessionId = result.sessionId
        await store.attachSession(conversation.id, result.sessionId)
        return result
      },
      clientData: { bindingId: lease.bindingId },
    })
    let toolResults = 0
    let textParts = 0
    for (const text of [
      "Prueba sintética. Responde exactamente: Praeco listo. No uses herramientas.",
      "Prueba sintética. Usa inspect_workspace una sola vez y después resume sus capacidades en una frase. No hagas operaciones financieras.",
    ]) {
      const currentUsage = await store.usage(conversation.id)
      if (currentUsage.some((row) => row.status !== "completed") || currentUsage.length >= 3) {
        throw new Error("CHAT_SMOKE_STOPPED_FOR_USAGE")
      }
      const stream = await transport.sendMessages({
        trigger: "submit-message", chatId: conversation.id,
        messageId: undefined,
        messages: [{ id: randomUUID(), role: "user", parts: [{ type: "text", text }] }],
        abortSignal: AbortSignal.timeout(90_000),
      })
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.type === "error") {
            const code = "errorText" in value ? value.errorText : ""
            throw new Error(/^CHAT_[A-Z_]+$/.test(code)
              ? `CHAT_SMOKE_${code}` : "CHAT_SMOKE_TURN_FAILED")
          }
          if (value.type === "tool-output-available") toolResults++
          if (value.type === "text-delta" && value.delta.length > 0) textParts++
        }
      } finally { reader.releaseLock() }
    }
    const usage = await store.usage(conversation.id)
    const total = usage.reduce((sum, row) => sum + usdToNanos(row.actualUsd ?? row.reservedUsd), 0n)
    if (usage.length > 3 || usage.some((row) => row.status !== "completed") ||
        total > usdToNanos("0.05") || !toolResults || !textParts) {
      throw new Error("CHAT_SMOKE_VALIDATION_FAILED")
    }
    const load = chat.createLoadTranscriptAction(defaultStorage, { limit: 50 })
    let history = await load({ chatId: conversation.id })
    for (let attempt = 0; history.messages.length < 4 && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      history = await load({ chatId: conversation.id })
    }
    if (history.messages.length < 4) throw new Error("CHAT_SMOKE_HISTORY_INCOMPLETE")
    console.log(JSON.stringify({
      model: configuration.OPENROUTER_MODEL, calls: usage.length,
      reportedCostUsd: nanosToUsd(total), toolResults, persistedMessages: history.messages.length,
      usage: usage.map(({ model, provider, actualUsd, inputTokens, outputTokens }) =>
        ({ model, provider, actualUsd, inputTokens, outputTokens })),
    }))
  } finally {
    try {
      if (sessionId) await sessions.close(sessionId)
    } finally {
      await pool.end()
      console.log("Synthetic Trigger session closed. Inference usage receipts retained in the isolated smoke scope.")
    }
  }
}

try { await main() }
catch (error) {
  console.error(error instanceof WorkspaceChatError ? error.code :
    error instanceof Error && /^CHAT_SMOKE_[A-Z_]+$/.test(error.message) ? error.message : "CHAT_OPERATION_FAILED")
  process.exitCode = 1
}
