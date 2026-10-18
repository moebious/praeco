/**
 * Synthetic payable intake catalog for the kernel-served finance surface.
 *
 * Scope rules for this module:
 * - It contains only *raw input* declarations: which synthetic document enters
 *   L1, through which channel, and how it is labelled. It never encodes a
 *   decided gate result or a target amount. The kernel derives every verdict at
 *   runtime from verified evidence.
 * - It must stay free of `@praeco/*` imports, storage access and `server-only`,
 *   so the labels can also be rendered by tests without booting the kernel.
 * - The files referenced here were copied byte-for-byte from the public
 *   synthetic corpus declared in `apps/finance-workspace/README.md`. No
 *   manifest or corpus listing is copied or read.
 */

/** Same ids as `createScenarioStore`, mirrored here to keep this module dependency-free. */
export type PayableScenarioId =
  | "BLINKA-01"
  | "BLINKA-02"
  | "BLINKA-03"
  | "BLINKA-04"
  | "BLINKA-05"
  | "BLINKA-06"
  | "BLINKA-07"
  | "BLINKA-08"

/** Raw intake described exactly as `L1Runtime.register` receives it. */
export interface PayableSourceDefinition {
  /** File name inside `fixtures/payable-sources/`. */
  readonly file: string
  readonly channel: "PDF" | "CHAT"
  readonly mimeType: string
  readonly displayName: string
  /** `context` documents accompany a primary invoice and carry no payable claim. */
  readonly role: "primary" | "context"
}

export interface PayableCaseDefinition {
  readonly caseId: string
  readonly scenarioId: PayableScenarioId
  readonly title: string
  readonly summary: string
  readonly sources: readonly PayableSourceDefinition[]
}

const pdfSource = (file: string, displayName: string): PayableSourceDefinition => ({
  file,
  channel: "PDF",
  mimeType: "application/pdf",
  displayName,
  role: "primary",
})

const chatSource = (
  file: string,
  displayName: string,
  role: PayableSourceDefinition["role"]
): PayableSourceDefinition => ({
  file,
  channel: "CHAT",
  mimeType: "text/plain",
  displayName,
  role,
})

export const PAYABLE_CASES: readonly PayableCaseDefinition[] = [
  {
    caseId: "payable-01",
    scenarioId: "BLINKA-01",
    title: "Factura 01 · servicios de desarrollo (Bogotá)",
    summary: "Factura PDF sintética por servicios mensuales de desarrollo.",
    sources: [pdfSource("01.pdf", "factura-01.pdf")],
  },
  {
    caseId: "payable-02",
    scenarioId: "BLINKA-02",
    title: "Factura 02 · suscripción SaaS",
    summary: "Suscripción mensual facturada, con un mensaje de contexto aparte.",
    sources: [
      pdfSource("02.pdf", "factura-02.pdf"),
      chatSource("02-context.txt", "contexto-02.txt", "context"),
    ],
  },
  {
    caseId: "payable-03",
    scenarioId: "BLINKA-03",
    title: "Factura 03 · agencia de diseño (CDMX)",
    summary: "Factura en pesos mexicanos de una agencia de diseño.",
    sources: [pdfSource("03.pdf", "factura-03.pdf")],
  },
  {
    caseId: "payable-04",
    scenarioId: "BLINKA-04",
    title: "Factura 04 · contratista (Argentina)",
    summary: "Factura en dólares con una propuesta de bono enviada por separado.",
    sources: [
      pdfSource("04.pdf", "factura-04.pdf"),
      chatSource("04-context.txt", "contexto-04.txt", "context"),
    ],
  },
  {
    caseId: "payable-05",
    scenarioId: "BLINKA-05",
    title: "Factura 05 · mensaje reenviado",
    summary: "Cuerpo de mensaje reenviado con el mismo número de factura del caso 01.",
    sources: [chatSource("05.txt", "mensaje-05.txt", "primary")],
  },
  {
    caseId: "payable-06",
    scenarioId: "BLINKA-06",
    title: "Factura 06 · beneficiario nuevo",
    summary: "Factura en pesos colombianos de un beneficiario no registrado.",
    sources: [pdfSource("06.pdf", "factura-06.pdf")],
  },
  {
    caseId: "payable-07",
    scenarioId: "BLINKA-07",
    title: "Factura 07 · contratista de servicios",
    summary: "Factura por servicios de contratista contra un período acotado.",
    sources: [pdfSource("07.pdf", "factura-07.pdf")],
  },
  {
    caseId: "payable-08",
    scenarioId: "BLINKA-08",
    title: "Factura 08 · proveedor conocido",
    summary: "Factura de un proveedor registrado con datos de cuenta distintos.",
    sources: [pdfSource("08.pdf", "factura-08.pdf")],
  },
  {
    caseId: "payable-09",
    scenarioId: "BLINKA-06",
    title: "Documento 09 · entrada incompleta",
    summary:
      "Entrada sintética sin los campos críticos. Sirve para comprobar que la superficie falla cerrada cuando L1 no emite evidencia lista.",
    sources: [chatSource("09-incomplete.txt", "documento-09.txt", "primary")],
  },
] as const

export function getPayableCase(caseId: string): PayableCaseDefinition | null {
  return PAYABLE_CASES.find((definition) => definition.caseId === caseId) ?? null
}

/** File name of the primary invoice inside a case; used only for display. */
export function primarySourceFile(definition: PayableCaseDefinition): string {
  return (
    definition.sources.find((source) => source.role === "primary")?.file ??
    definition.sources[0]?.file ??
    "sin-fuente"
  )
}
