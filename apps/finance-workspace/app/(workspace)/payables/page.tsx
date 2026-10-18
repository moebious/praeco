import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Info, Server } from "lucide-react"

import { PayableOutcomeBadge } from "@/components/payable-outcome"
import { Badge } from "@/components/ui/badge"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { PAYABLE_CASES, primarySourceFile } from "@/lib/finance/cases"
import { getFinanceRuntime } from "@/lib/finance/runtime"
import { requireFinancePageAccess } from "@/lib/finance/page-access"

/**
 * Payable surface: the case list reads `params`-free dynamic state and the
 * in-process ledger, so it blocks on the server by design (documented Cache
 * Components opt-out in Next 16).
 */
export const instant = false

export const metadata: Metadata = { title: "Cuentas por pagar" }

export default async function PayablesPage() {
  const access = await requireFinancePageAccess()
  const runtime = getFinanceRuntime()
  const cases = PAYABLE_CASES.map((definition) => ({
    definition,
    decision: runtime.latestDecision(definition.caseId),
  }))

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <SidebarTrigger aria-label="Alternar navegación" />
        <span className="text-sm font-medium">Cuentas por pagar</span>
        {access.synthetic ? (
          <Badge variant="outline" className="ml-auto">
            actor sintético
          </Badge>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Casos por pagar sintéticos</h1>
            <p className="text-sm text-muted-foreground">
              Cada caso se procesa con el pipeline L1 real y se evalúa con el kernel determinista de
              seis controles. Esta vista no calcula resultados por su cuenta: solo presenta lo que el
              kernel decide.
            </p>
          </div>

          <p className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground shadow-border">
            <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
            <span>
              Identidad actuante: <strong className="font-medium">{access.actorLabel}</strong>. Datos
              enteramente sintéticos; no hay dinero real ni ejecución de desembolsos. Una
              autorización se muestra siempre como <code>AUTHORIZED_SIMULATED</code>, nunca como un
              desembolso completado.
            </span>
          </p>

          <p className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground shadow-border">
            <Server className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
            <span>
              Runtime de demostración en proceso (ADR-007): la evidencia L1 queda en un almacén de
              archivos, pero el ledger de autorizaciones vive solo en memoria del proceso. Al
              reiniciar, los casos vuelven a estado sin decidir: no hay durabilidad entre procesos.
            </span>
          </p>

          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {cases.map(({ definition, decision }) => (
              <li key={definition.caseId}>
                <Link
                  href={`/payables/${definition.caseId}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{definition.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {definition.summary}
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {definition.caseId} · {definition.scenarioId} ·{" "}
                      {primarySourceFile(definition)}
                    </span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-3">
                    {decision ? (
                      <PayableOutcomeBadge outcome={decision.outcome} />
                    ) : (
                      <Badge variant="outline">sin decidir</Badge>
                    )}
                    <ArrowRight
                      className="size-3.5 text-muted-foreground"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}
