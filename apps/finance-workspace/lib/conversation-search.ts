import type { ConversationSummary } from "@/lib/conversations"

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es").trim()
}

/** Filter only the conversations the server already authorized for this view. */
export function filterConversations(
  conversations: readonly ConversationSummary[],
  query: string
): readonly ConversationSummary[] {
  const term = normalizeSearch(query)
  if (!term) return conversations
  return conversations.filter((conversation) =>
    normalizeSearch(`${conversation.title} ${conversation.preview}`).includes(term)
  )
}
