import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { ChatHeader } from "@/components/chat-header"
import { Chat } from "@/components/chat"
import { getDemoThread } from "@/lib/demo-data"
import { requireWorkspacePageAccess } from "@/lib/auth"
import { getWorkspaceConversation } from "@/lib/conversation-service"
import { WorkspaceMetadataError } from "@/lib/conversations"
import { WorkspaceMetadataNotice } from "@/components/workspace-metadata-notice"
import { renameConversation } from "@/actions/conversations"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LiveChat } from "@/components/live-chat"
import { chatIsConfigured } from "@/lib/chat/config"

/**
 * Per-conversation route: it reads `params` at request time, so it blocks on the
 * server by design (documented Cache Components opt-out in Next 16).
 */
export const instant = false

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chatId: string }>
}): Promise<Metadata> {
  await requireWorkspacePageAccess()
  const { chatId } = await params
  try {
    const { conversation } = await getWorkspaceConversation(chatId)
    return { title: conversation?.title ?? "Conversación" }
  } catch {
    return { title: "Conversación no disponible" }
  }
}

export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>
}) {
  await requireWorkspacePageAccess()
  const { chatId } = await params
  let workspace
  try {
    workspace = await getWorkspaceConversation(chatId)
  } catch (error) {
    if (error instanceof WorkspaceMetadataError) return <WorkspaceMetadataNotice code={error.code} />
    throw error
  }
  const { conversation } = workspace
  if (!conversation) notFound()

  return (
    <>
      <ChatHeader conversation={conversation} />
      {workspace.mode === "persisted" ? (
        <form action={renameConversation} className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <input type="hidden" name="conversationId" value={conversation.id} />
          <label htmlFor="conversation-title" className="sr-only">Título de la conversación</label>
          <Input id="conversation-title" name="title" defaultValue={conversation.title}
            maxLength={120} required className="max-w-sm" />
          <Button type="submit" size="sm" variant="outline">Guardar título</Button>
        </form>
      ) : null}
      {workspace.mode === "persisted" && chatIsConfigured() ? (
        <LiveChat chatId={conversation.id} specialistId={conversation.participants[0]} />
      ) : <Chat
        key={conversation.id}
        specialistId={conversation.participants[0]}
        thread={workspace.mode === "demo" ? getDemoThread(conversation.id) : []}
        notice={workspace.mode === "persisted"
          ? "Metadata guardada en PostgreSQL. Estos mensajes son programados, no se guardan y se pierden al recargar. Sin proveedor de modelo ni ejecución financiera."
          : undefined}
      />}
    </>
  )
}
