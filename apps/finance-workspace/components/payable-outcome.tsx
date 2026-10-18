import { Badge } from "@/components/ui/badge"
import type { FinancialOutcome } from "@praeco/financial-decision-kernel"

/**
 * The kernel outcome is rendered as its exact literal. `AUTHORIZED_SIMULATED`
 * is never replaced by a completion-of-payment word, and the accompanying
 * description restates that no real money moved.
 */
const VARIANT: Record<FinancialOutcome, "default" | "destructive" | "secondary"> = {
  AUTHORIZED_SIMULATED: "default",
  BLOCKED: "destructive",
  PENDING_HUMAN_APPROVAL: "secondary",
}

export function PayableOutcomeBadge({ outcome }: { outcome: FinancialOutcome }) {
  return <Badge variant={VARIANT[outcome]}>{outcome}</Badge>
}

export function payableOutcomeDescription(outcome: FinancialOutcome): string {
  switch (outcome) {
    case "AUTHORIZED_SIMULATED":
      return "El kernel registró una autorización simulada. No es un desembolso ni una transferencia real."
    case "BLOCKED":
      return "Un control duro del kernel bloqueó el caso. Ninguna aprobación humana puede saltarlo."
    case "PENDING_HUMAN_APPROVAL":
      return "Una persona con rol FinanceAdmin debe resolver la solicitud antes de cualquier autorización."
  }
}

export function PayableEvidenceBadge({
  ready,
  status,
}: {
  ready: boolean
  status: string
}) {
  if (ready) return <Badge variant="outline">{status}</Badge>
  return <Badge variant="destructive">{status}</Badge>
}
