import { getConversationStore } from "@/db/connection"
import { requireWorkspaceActor, WorkspaceAccessError } from "@/lib/auth"
import { metadataFailure } from "@/lib/conversations"

export async function GET() {
  try {
    const actor = await requireWorkspaceActor()
    const conversations = await getConversationStore().list(actor)
    return Response.json({ conversations }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return Response.json(
      { error: error instanceof WorkspaceAccessError ? error.code : metadataFailure(error).code },
      { status: error instanceof WorkspaceAccessError ? error.status : 503,
        headers: { "Cache-Control": "no-store" } }
    )
  }
}
