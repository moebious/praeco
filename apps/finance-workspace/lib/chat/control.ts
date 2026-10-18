import "server-only"
import { auth as triggerAuth, configure } from "@trigger.dev/sdk"
import { chat, defaultStorage } from "@trigger.dev/sdk/ai"
import { z } from "zod"
import { validateUIMessages } from "ai"
import { getConversationStore } from "@/db/connection"
import { getChatStore } from "@/db/chat-store"
import { requireWorkspaceActor } from "@/lib/auth"
import { readChatConfiguration } from "@/lib/chat/config"
import {
  CHAT_TASK_ID, CHAT_TOKEN_TTL, chatIdInput, transcriptInput, safeChatError, WorkspaceChatError,
  type WorkspaceChatMessage,
} from "@/lib/chat/contracts"
import { workspaceChatTools } from "@/lib/chat/tools"

async function ownedChat(input: unknown) {
  const actor = await requireWorkspaceActor()
  const parsed = chatIdInput.safeParse(input)
  if (!parsed.success) throw new WorkspaceChatError("CHAT_INPUT_INVALID")
  const conversation = await getConversationStore().get(actor, parsed.data.chatId)
  if (!conversation) throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
  const configuration = readChatConfiguration()
  configure({ secretKey: configuration.TRIGGER_SECRET_KEY, baseURL: "https://api.trigger.dev" })
  return { actor, chatId: parsed.data.chatId }
}

export async function startOwnedChat(input: unknown) {
  const inputSchema = chatIdInput.extend({ bindingId: z.uuid() }).strict()
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    await requireWorkspaceActor()
    throw new WorkspaceChatError("CHAT_INPUT_INVALID")
  }
  const { actor, chatId } = await ownedChat({ chatId: parsed.data.chatId })
  try {
    const lease = await getChatStore().authorize(actor, chatId)
    if (lease.bindingId !== parsed.data.bindingId) throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
    const start = chat.createStartSessionAction(CHAT_TASK_ID, { tokenTTL: CHAT_TOKEN_TTL })
    const session = await start({ chatId, clientData: { bindingId: lease.bindingId } })
    await getChatStore().attachSession(chatId, session.sessionId)
    return session
  } catch (error) { throw safeChatError(error) }
}

export async function mintOwnedChatToken(input: unknown) {
  const { actor, chatId } = await ownedChat(input)
  try {
    await getChatStore().authorize(actor, chatId)
    return await triggerAuth.createPublicToken({
      scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
      expirationTime: CHAT_TOKEN_TTL,
    })
  } catch (error) { throw safeChatError(error) }
}

export async function loadOwnedTranscript(input: unknown) {
  const parsed = transcriptInput.safeParse(input)
  // Auth still runs for malformed input, before any provider/store operation.
  if (!parsed.success) {
    await requireWorkspaceActor()
    throw new WorkspaceChatError("CHAT_INPUT_INVALID")
  }
  const { actor, chatId } = await ownedChat({ chatId: parsed.data.chatId })
  try {
    if (!await getChatStore().session(actor, chatId)) return { messages: [] as WorkspaceChatMessage[] }
    const load = chat.createLoadTranscriptAction(defaultStorage, { limit: 50 })
    const result = await load({ chatId, before: parsed.data.before, limit: 50 })
    const messages = await validateUIMessages<WorkspaceChatMessage>({
      messages: result.messages, tools: workspaceChatTools,
    })
    return { messages, cursors: result.cursors, nextCursor: result.nextCursor }
  } catch (error) { throw safeChatError(error) }
}

export async function bootstrapOwnedChat(input: unknown) {
  const { actor, chatId } = await ownedChat(input)
  try {
    const access = await getChatStore().authorize(actor, chatId)
    const sessionId = access.sessionId
    if (!sessionId) return {
      bindingId: access.bindingId, messages: [] as WorkspaceChatMessage[],
      session: undefined, nextCursor: undefined,
    }
    const [history, token] = await Promise.all([
      loadOwnedTranscript({ chatId }), mintOwnedChatToken({ chatId }),
    ])
    return {
      messages: history.messages,
      bindingId: access.bindingId,
      session: { publicAccessToken: token, lastEventId: "cursors" in history ? history.cursors?.lastOutEventId : undefined },
      nextCursor: "nextCursor" in history ? history.nextCursor : undefined,
    }
  } catch (error) { throw safeChatError(error) }
}
