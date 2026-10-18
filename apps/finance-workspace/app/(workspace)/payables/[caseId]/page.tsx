import { randomUUID } from "node:crypto"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, FileText, Info, ShieldCheck } from "lucide-react"

import {
  PayableEvidenceBadge,
  PayableOutcomeBadge,
  payableOutcomeDescription,
} from "@/components/payable-outcome"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { getAuthConfiguration } from "@/lib/auth-config"
import { getPayableCase } from "@/lib/finance/cases"
import { isFinanceWorkspaceError, type PayableCaseView } from "@/lib/finance/contracts"
import { requireFinancePageAccess } from "@/lib/finance/page-access"
import { getFinanceRuntime } from "@/lib/finance/runtime"
import type { FinancialDecisionRecord, FinancialEvaluation } from "@praeco/financial-decision-kernel"

/** Reads `params` and the in-process ledger at request time (Cache Components opt-out). */
export const instant = false

export async function generateMetadata({
  params,
}: {
  params: Promise<{ caseId: string }>
}): Promise<Metadata> {
  const { caseId } = await params
  return { title: getPayableCase(caseId)?.title ?? "Caso no encontrado" }
}

function GateTable({ evaluation }: { evaluation: FinancialEvaluation }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Resultado de los seis controles del kernel</caption>
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Control</th>
            <th scope="col" className="px-3 py-2 font-medium">Estado</th>
            <th scope="col" className="px-3 py-2 font-medium">Código</th>
            <th scope="col" className="px-3 py-2 font-medium">Explicación</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {evaluation.gateChecks.map((check) => (
            <tr key={check.gate} className="align-top">
              <td className="px-3 py-2 font-mono">{check.gate}</td>
              <td className="px-3 py-2">
                <Badge variant={check.status === "PASS" ? "outline" : "secondary"}>
                  {check.status}
                </Badge>
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{check.code}</td>
              <td className="px-3 py-2 text-muted-foreground">{check.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function OutcomeHeader({
  outcome,
  explanation,
  badges = [],
}: {
  outcome: FinancialDecisionRecord["outcome"]
  explanation: string
  badges?: readonly string[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <PayableOutcomeBadge outcome={outcome} />
        {badges.map((badge) => (
          <Badge key={badge} variant="outline">
            {badge}
          </Badge>
        ))}
      </div>
      <p className="text-sm">{explanation}</p>
      <p className="text-xs text-muted-foreground">{payableOutcomeDescription(outcome)}</p>
    </div>
  )
}

function DecisionSummary({ decision }: { decision: FinancialDecisionRecord }) {
  return (
    <div className="flex flex-col gap-3">
      <OutcomeHeader
        outcome={decision.outcome}
        explanation={decision.explanation}
        badges={[
          `${decision.gateChecks.length} controles evaluados`,
          ...(decision.commitmentId ? ["compromiso simulado registrado"] : []),
        ]}
      />
      <dl className="grid gap-1 text-xs text-muted-foreground">
        <div className="flex gap-2">
          <dt className="font-medium">decisionId</dt>
          <dd className="font-mono break-all">{decision.decisionId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">evaluado en</dt>
          <dd className="font-mono">{decision.occurredAt}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">policyRevisionId</dt>
          <dd className="font-mono break-all">{decision.policyRevisionId}</dd>
        </div>
      </dl>
    </div>
  )
}

function EvidencePanel({ view }: { view: PayableCaseView }) {
  if (view.evidenceError) {
    return (
      <p role="status" className="text-sm text-destructive">
        Evidencia no disponible ({view.evidenceError}). El caso queda sin decisión: la superficie falla
        cerrada y no ofrece ninguna acción de decisión.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {view.sources.map((source) => (
        <div key={source.file} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="size-3.5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
            <span className="font-mono text-xs">{source.file}</span>
            <Badge variant="outline">{source.channel}</Badge>
            <Badge variant="secondary">{source.role === "primary" ? "documento principal" : "contexto"}</Badge>
            <Badge variant="ghost">{source.disposition}</Badge>
          </div>
          {source.envelopes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              L1 clasificó esta entrada como contexto complementario: no aporta ningún reclamo de cobro.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {source.envelopes.map((envelope) => (
                <li
                  key={envelope.envelopeId}
                  className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <PayableEvidenceBadge ready={envelope.ready} status={envelope.processingStatus} />
                    {envelope.verificationStatus ? (
                      <Badge variant="outline">verificación {envelope.verificationStatus}</Badge>
                    ) : null}
                    {envelope.usdEquivalent ? (
                      <Badge variant="secondary">equivalente {envelope.usdEquivalent}</Badge>
                    ) : null}
                  </div>
                  <span className="font-mono text-[11px] break-all text-muted-foreground">
                    {envelope.envelopeId}
                  </span>
                  {envelope.issues.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      incidencias: {envelope.issues.join(", ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

export default async function PayableCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>
  searchParams: Promise<{ financeError?: string }>
}) {
  const access = await requireFinancePageAccess()
  const [{ caseId }, query] = await Promise.all([params, searchParams])
  const runtime = getFinanceRuntime()

  let view: PayableCaseView
  try {
    view = await runtime.view(caseId, access.actor)
  } catch (error) {
    if (isFinanceWorkspaceError(error) && error.code === "CASE_NOT_FOUND") notFound()
    throw error
  }

  const canDecide = view.readyEnvelopeCount > 0 && view.evidenceError === null
  const approvalPending = view.approval?.status === "PENDING"
  const identityConfigured = getAuthConfiguration().mode === "clerk"

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <SidebarTrigger aria-label="Alternar navegación" />
        <Link
          href="/payables"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.5} aria-hidden />
          Cuentas por pagar
        </Link>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{view.caseId}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{view.title}</h1>
              <Badge variant="outline">{view.scenarioId}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{view.summary}</p>
          </div>

          <p className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground shadow-border">
            <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
            <span>
              Identidad actuante: <strong className="font-medium">{access.actorLabel}</strong>. Datos
              sintéticos, sin dinero real. El ledger de autorizaciones es en memoria del proceso
              (ADR-007); reiniciar borra las decisiones.
            </span>
          </p>

          {query.financeError ? (
            <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              La acción no se aplicó: {query.financeError}. No se registró ninguna autorización.
            </p>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Evidencia L1</CardTitle>
              <CardDescription>
                Resumen seguro del pipeline real: identificadores, estado de procesamiento, verificación
                y equivalente en dólares. No se exponen cuentas ni el texto crudo de la factura.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EvidencePanel view={view} />
            </CardContent>
          </Card>

          {view.preview ? (
            <Card>
              <CardHeader>
                <CardTitle>Previsualización L2</CardTitle>
                <CardDescription>
                  Evaluación de solo lectura: no crea obligación, ni compromiso, ni recibo de
                  idempotencia.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <OutcomeHeader
                  outcome={view.preview.outcome}
                  explanation={view.preview.explanation}
                  badges={[`${view.preview.gateChecks.length} controles evaluados`, "sin commit"]}
                />
                <GateTable evaluation={view.preview} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Veredicto del kernel</CardTitle>
              <CardDescription>
                Controles deterministas de evidencia, duplicado, beneficiario y cuenta, contrato,
                presupuesto y umbral de autorización automática.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {view.decision ? (
                <>
                  <DecisionSummary decision={view.decision} />
                  <GateTable evaluation={view.decision} />
                </>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  Sin decisiones registradas por este proceso para este caso. Previsualizá o decidí
                  desde las acciones de abajo.
                </p>
              )}
            </CardContent>
          </Card>

          {view.approval ? (
            <Card>
              <CardHeader>
                <CardTitle>Solicitud de aprobación humana</CardTitle>
                <CardDescription>
                  Solo el rol <strong className="font-medium">FinanceAdmin</strong> puede resolverla, y
                  el kernel reevalúa todos los controles duros en el momento de la resolución.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <dl className="grid gap-1 text-xs text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="font-medium">solicitud</dt>
                    <dd className="font-mono break-all">{view.approval.approvalRequestId}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium">estado</dt>
                    <dd>{view.approval.status}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium">monto solicitado</dt>
                    <dd className="font-mono">USD {view.approval.unroundedUsd}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium">expira</dt>
                    <dd className="font-mono">{view.approval.expiresAt}</dd>
                  </div>
                </dl>

                {approvalPending && access.canApprove ? (
                  <div className="flex flex-wrap gap-2">
                    <form method="post" action={`/api/payables/${view.caseId}/approvals/${view.approval.approvalRequestId}`}>
                      <input type="hidden" name="action" value="APPROVE" />
                      <input type="hidden" name="idempotencyKey" value={`approve-${randomUUID()}`} />
                      <Button type="submit" size="sm">
                        Aprobar solicitud
                      </Button>
                    </form>
                    <form method="post" action={`/api/payables/${view.caseId}/approvals/${view.approval.approvalRequestId}`}>
                      <input type="hidden" name="action" value="REJECT" />
                      <input type="hidden" name="idempotencyKey" value={`reject-${randomUUID()}`} />
                      <Button type="submit" size="sm" variant="outline">
                        Rechazar solicitud
                      </Button>
                    </form>
                  </div>
                ) : approvalPending ? (
                  <p role="status" className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground shadow-border">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    <span>
                      Aprobación no configurada: la identidad verificada no tiene el rol FinanceAdmin.
                      {identityConfigured
                        ? " El rol se lee del proveedor de identidad en el servidor; esta superficie no ofrece la acción de aprobación."
                        : null}
                    </span>
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Acciones</CardTitle>
              <CardDescription>
                Cada comando lleva una clave de idempotencia propia. Repetir la misma clave devuelve la
                misma decisión; una clave nueva sobre la misma factura es un comando distinto y el
                kernel lo evalúa de nuevo.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {canDecide ? (
                <div className="flex flex-wrap gap-2">
                  <form method="post" action={`/api/payables/${view.caseId}/preview`}>
                    <Button type="submit" size="sm" variant="outline">
                      Previsualizar decisión
                    </Button>
                  </form>
                  <form method="post" action={`/api/payables/${view.caseId}/decide`}>
                    <input type="hidden" name="idempotencyKey" value={`decide-${randomUUID()}`} />
                    <Button type="submit" size="sm">
                      Evaluar y decidir
                    </Button>
                  </form>
                </div>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  Sin evidencia lista de L1, las acciones de decisión quedan deshabilitadas: el caso
                  falla cerrado y no se puede autorizar nada desde aquí.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
