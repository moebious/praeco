import { resolveFinanceAccess } from "@/lib/finance/access"
import {
  financeCrossOriginResponse,
  financeFailureResponse,
  financeSuccess,
  isSameOrigin,
  safeEvaluation,
} from "@/lib/finance/http"
import { getFinanceRuntime } from "@/lib/finance/runtime"

/**
 * Read-only L2 evaluation. It creates no obligation, commitment or idempotency
 * receipt; the identity is re-resolved here, next to the data.
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
    const evaluation = await getFinanceRuntime().preview(caseId, access.actor)
    return financeSuccess(request, returnPath, { preview: safeEvaluation(evaluation) })
  } catch (error) {
    return financeFailureResponse(request, error, returnPath)
  }
}
