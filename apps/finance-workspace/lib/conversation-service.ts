import "server-only"

import { cache } from "react"

import { getConversationStore } from "@/db/connection"
import { requireWorkspaceActor } from "@/lib/auth"
import { getAuthConfiguration } from "@/lib/auth-config"
import {
  metadataFailure, openConversationInput, renameConversationInput,
  summarizeConversation, WorkspaceMetadataError,
  type ConversationSummary, type MetadataErrorCode,
} from "@/lib/conversations"
import { DEMO_CONVERSATIONS, getConversation } from "@/lib/demo-data"

export type WorkspaceConversations =
  | { mode: "demo" | "persisted"; conversations: readonly ConversationSummary[] }
  | { mode: "unavailable"; conversations: readonly ConversationSummary[]; code: MetadataErrorCode }

/** Render-request cache only; never share authenticated data across requests. */
export const getWorkspaceConversations = cache(async (): Promise<WorkspaceConversations> => {
  if (getAuthConfiguration().mode === "demo") {
    return { mode: "demo", conversations: DEMO_CONVERSATIONS }
  }
  const actor = await requireWorkspaceActor()
  try {
    const rows = await getConversationStore().list(actor)
    return { mode: "persisted", conversations: rows.map(summarizeConversation) }
  } catch (error) {
    return { mode: "unavailable", conversations: [], code: metadataFailure(error).code }
  }
})

export const getWorkspaceConversation = cache(async (id: string) => {
  if (getAuthConfiguration().mode === "demo") {
    return { mode: "demo" as const, conversation: getConversation(id) }
  }
  const actor = await requireWorkspaceActor()
  try {
    const row = await getConversationStore().get(actor, id)
    return { mode: "persisted" as const, conversation: row ? summarizeConversation(row) : null }
  } catch (error) {
    throw metadataFailure(error)
  }
})

export async function openWorkspaceConversation(input: unknown): Promise<string> {
  const actor = await requireWorkspaceActor()
  const parsed = openConversationInput.safeParse(input)
  if (!parsed.success) throw new WorkspaceMetadataError("INVALID_CONVERSATION_INPUT")
  const rows = await getConversationStore().initialize(actor)
  const conversation = rows.find((row) => row.specialistId === parsed.data.specialistId)
  if (!conversation) throw new WorkspaceMetadataError("DATABASE_UNAVAILABLE")
  return conversation.id
}

export async function renameWorkspaceConversation(input: unknown): Promise<string> {
  const actor = await requireWorkspaceActor()
  const parsed = renameConversationInput.safeParse(input)
  if (!parsed.success) throw new WorkspaceMetadataError("INVALID_CONVERSATION_INPUT")
  const row = await getConversationStore().rename(actor, parsed.data.conversationId, parsed.data.title)
  if (!row) throw new WorkspaceMetadataError("CONVERSATION_NOT_FOUND")
  return row.id
}
