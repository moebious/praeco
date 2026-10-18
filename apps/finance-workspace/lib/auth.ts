import "server-only"

import { auth } from "@clerk/nextjs/server"
import { connection } from "next/server"
import { redirect } from "next/navigation"

import { getAuthConfiguration } from "@/lib/auth-config"

export class WorkspaceAccessError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly code: "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE"
  ) {
    super(code)
    this.name = "WorkspaceAccessError"
  }
}

export interface WorkspaceActor {
  readonly userId: string
  readonly tenantId: string
  /** Authentication never grants financial approval authority. */
  readonly role: "member"
}

/** Recheck in every action/data handler, even when Proxy already checked a request. */
export async function requireWorkspaceActor(): Promise<WorkspaceActor> {
  if (getAuthConfiguration().mode !== "clerk") {
    throw new WorkspaceAccessError(503, "AUTHENTICATION_UNAVAILABLE")
  }

  let session
  try {
    session = await auth()
  } catch {
    throw new WorkspaceAccessError(503, "AUTHENTICATION_UNAVAILABLE")
  }
  if (!session.userId) {
    throw new WorkspaceAccessError(401, "AUTHENTICATION_REQUIRED")
  }

  return {
    userId: session.userId,
    tenantId: session.orgId ? `org:${session.orgId}` : `user:${session.userId}`,
    role: "member",
  }
}

/** Only public synthetic screens may render without a configured identity service. */
export async function requireWorkspacePageAccess(): Promise<boolean> {
  await connection()
  const configuration = getAuthConfiguration()
  if (configuration.mode === "demo") return false
  if (configuration.mode === "unavailable") redirect("/auth/setup")

  const session = await auth()
  if (!session.userId) session.redirectToSignIn()
  return true
}
