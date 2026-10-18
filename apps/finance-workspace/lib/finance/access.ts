import "server-only"

import { auth } from "@clerk/nextjs/server"

import { getAuthConfiguration } from "@/lib/auth-config"
import { requireWorkspaceActor, WorkspaceAccessError } from "@/lib/auth"
import {
  FINANCE_ADMIN_ROLE,
  FINANCE_ROLES_CLAIM,
  SYNTHETIC_DEMO_ACTOR_LABEL,
  SYNTHETIC_DEMO_PRINCIPAL_ID,
} from "@/lib/finance/contracts"
import { DEMO_TENANT_ID, type TrustedActorContext } from "@praeco/financial-decision-kernel"

export interface FinanceAccess {
  /**
   * Context handed to the kernel. The payable corpus is one synthetic tenant, so
   * the tenant is fixed even when the identity is a verified organisation.
   */
  readonly actor: TrustedActorContext
  /** True only for a FinanceAdmin: grants the approval surface and its routes. */
  readonly canApprove: boolean
  /** True when the actor is the labelled synthetic demo identity. */
  readonly synthetic: boolean
  readonly actorLabel: string
}

function sessionRoles(claims: unknown): readonly string[] {
  if (!claims || typeof claims !== "object") return []
  const declared = (claims as Record<string, unknown>)[FINANCE_ROLES_CLAIM]
  if (!Array.isArray(declared)) return []
  return [...new Set(declared.filter((role): role is string => typeof role === "string"))]
}

/**
 * Fails closed. With no identity service the labelled synthetic FinanceAdmin is
 * used; otherwise the actor must carry a verified FinanceAdmin claim, and a
 * missing or invalid identity raises the same `WorkspaceAccessError` the rest of
 * the workspace uses. Roles are re-read here, next to the data, never taken from
 * the browser.
 */
export async function resolveFinanceAccess(): Promise<FinanceAccess> {
  const configuration = getAuthConfiguration()

  if (configuration.mode === "demo") {
    return {
      actor: {
        tenantId: DEMO_TENANT_ID,
        principalId: SYNTHETIC_DEMO_PRINCIPAL_ID,
        roles: [FINANCE_ADMIN_ROLE],
      },
      canApprove: true,
      synthetic: true,
      actorLabel: SYNTHETIC_DEMO_ACTOR_LABEL,
    }
  }

  if (configuration.mode === "unavailable") {
    throw new WorkspaceAccessError(503, "AUTHENTICATION_UNAVAILABLE")
  }

  const member = await requireWorkspaceActor()
  const session = await auth()
  if (!session.userId) throw new WorkspaceAccessError(401, "AUTHENTICATION_REQUIRED")

  const roles = sessionRoles(session.sessionClaims)
  const canApprove = roles.includes(FINANCE_ADMIN_ROLE)

  return {
    actor: { tenantId: DEMO_TENANT_ID, principalId: member.userId, roles },
    canApprove,
    synthetic: false,
    actorLabel: canApprove
      ? "Administrador financiero verificado por el proveedor de identidad"
      : "Identidad verificada sin rol FinanceAdmin",
  }
}
