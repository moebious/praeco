import { requireWorkspaceActor, WorkspaceAccessError } from "@/lib/auth"

/** Read-only authenticated diagnostic, independent of the browser and layout guard. */
export async function GET() {
  try {
    const actor = await requireWorkspaceActor()
    return Response.json(
      { authenticated: true, ...actor },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    const status = error instanceof WorkspaceAccessError ? error.status : 503
    const code = error instanceof WorkspaceAccessError ? error.code : "AUTHENTICATION_UNAVAILABLE"
    return Response.json(
      { error: code },
      { status, headers: { "Cache-Control": "no-store" } }
    )
  }
}
