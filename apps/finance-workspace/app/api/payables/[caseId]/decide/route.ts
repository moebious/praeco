import { resolveFinanceAccess } from "@/lib/finance/access"
import {
  financeCrossOriginResponse,
  financeFailureResponse,
  financeSuccess,
  isSameOrigin,
  readCommandPayload,
  readString,
  safeDecision,
} from "@/lib/finance/http"
import { getFinanceRuntime } from "@/lib/finance/runtime"

/**
 * Commits one financial decision through the kernel with the caller's
 * idempotency key. Repeating the same key returns the same decision; the actor
 * is re-resolved here and the kernel re-checks tenant and grant.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params
  const returnPath = `/payables/${caseId}`

  if (!isSameOrigin(request)) return financeCrossOriginResponse(request, returnPath)

  try {
    const access = await resolveFinanceAccess()
    const payload = await readCommandPayload(request)
    const decision = await getFinanceRuntime().decide(
      caseId,
      access.actor,
      readString(payload, "idempotencyKey")
    )
    return financeSuccess(request, returnPath, { decision: safeDecision(decision) })
  } catch (error) {
    return financeFailureResponse(request, error, returnPath)
  }
}
