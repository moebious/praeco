import { resolveFinanceAccess } from "@/lib/finance/access"
import { FinanceWorkspaceError } from "@/lib/finance/contracts"
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
 * Resolves one human approval request (APPROVE or REJECT). The role is checked
 * again here and inside the kernel; a non-FinanceAdmin actor never reaches the
 * ledger. The approval request must belong to the case named in the path.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string; approvalRequestId: string }> }
) {
  const { caseId, approvalRequestId } = await params
  const returnPath = `/payables/${caseId}`

  if (!isSameOrigin(request)) return financeCrossOriginResponse(request, returnPath)

  try {
    const access = await resolveFinanceAccess()
    const payload = await readCommandPayload(request)
    const action = readString(payload, "action")
    if (action !== "APPROVE" && action !== "REJECT") {
      throw new FinanceWorkspaceError("INVALID_ACTION")
    }
    const decision = await getFinanceRuntime().resolveApproval(
      caseId,
      {
        approvalRequestId,
        idempotencyKey: readString(payload, "idempotencyKey"),
        action,
      },
      access.actor
    )
    return financeSuccess(request, returnPath, { decision: safeDecision(decision) })
  } catch (error) {
    return financeFailureResponse(request, error, returnPath)
  }
}
