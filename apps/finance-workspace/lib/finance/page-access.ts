import "server-only"

import { redirect } from "next/navigation"

import { WorkspaceAccessError } from "@/lib/auth"
import { hasErrorName } from "@/lib/finance/contracts"
import { resolveFinanceAccess, type FinanceAccess } from "@/lib/finance/access"

/**
 * Page guard for the payable surface. The workspace layout already ran
 * `requireWorkspacePageAccess()`; this re-checks the actor next to the data and
 * sends the two workspace-level failures to their dedicated screens.
 */
export async function requireFinancePageAccess(): Promise<FinanceAccess> {
  try {
    return await resolveFinanceAccess()
  } catch (error) {
    // Structural brand check: `instanceof` can fail across bundled module copies.
    if (!(error instanceof WorkspaceAccessError || hasErrorName(error, "WorkspaceAccessError"))) {
      throw error
    }
    const status = (error as { status?: unknown }).status
    redirect(status === 401 ? "/sign-in" : "/auth/setup")
  }
}
