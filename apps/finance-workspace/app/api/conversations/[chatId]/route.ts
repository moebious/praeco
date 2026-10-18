import { getConversationStore } from "@/db/connection"
import { requireWorkspaceActor, WorkspaceAccessError } from "@/lib/auth"
import { metadataFailure } from "@/lib/conversations"

export async function GET(_request: Request, { params }: { params: Promise<{ chatId: string }> }) {
  try {
    const actor = await requireWorkspaceActor()
    const { chatId } = await params
    const conversation = await getConversationStore().get(actor, chatId)
    return Response.json(conversation ? { conversation } : { error: "CONVERSATION_NOT_FOUND" },
      { status: conversation ? 200 : 404, headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return Response.json(
      { error: error instanceof WorkspaceAccessError ? error.code : metadataFailure(error).code },
      { status: error instanceof WorkspaceAccessError ? error.status : 503,
        headers: { "Cache-Control": "no-store" } }
    )
  }
}
