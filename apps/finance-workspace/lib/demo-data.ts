/**
 * B1 demo content. Fully programmed and synthetic: there is no provider,
 * worker or financial integration in this block, and the UI says so.
 * No decision vocabulary, no completion-of-payment wording, and no reference
 * branding. The kernel remains the only place that decides about money.
 */

export const DEMO_NOTICE =
  "Modo demo: conversación programada con datos sintéticos. Sin proveedor de modelo, sin ejecución financiera y sin durabilidad entre procesos."

export const DEMO_TENANT_LABEL = "Tenant sintético de demostración"

export type SpecialistId = "vera" | "kael" | "nova"

export interface Specialist {
  id: SpecialistId
  name: string
  role: string
  /** Short capability note shown in the profile header. Visible profile grants no authority. */
  note: string
}

export const SPECIALISTS: readonly Specialist[] = [
  {
    id: "vera",
    name: "Vera",
    role: "Analista de evidencia",
    note: "Solicita procesamiento L1 y presenta evidencia e incertidumbres.",
  },
  {
    id: "kael",
    name: "Kael",
    role: "Auditor de políticas",
    note: "Solicita evaluación L2 y explica el resultado de las seis reglas.",
  },
  {
    id: "nova",
    name: "Nova",
    role: "Control de wallet",
    note: "Presenta presupuesto, compromisos simulados y solicitudes de aprobación.",
  },
] as const

/** `review` is an evidence state that needs a person, distinct from a failed run (`error`). */
export type ToolStatus = "running" | "completed" | "review" | "error"

export interface TextPart {
  kind: "text"
  text: string
}

export interface ToolPart {
  kind: "tool"
  id: string
  name: string
  summary: string
  status: ToolStatus
  detail?: string
  /** True only for an interrupted run that can be run again on demand. */
  retryable?: boolean
}

export type MessagePart = TextPart | ToolPart

export interface DemoMessage {
  id: string
  author: SpecialistId | "user"
  at: string
  parts: readonly MessagePart[]
}

export interface DemoConversation {
  id: string
  title: string
  participants: readonly SpecialistId[]
  preview: string
  activity: string
  unread: number
}

export const DEMO_CONVERSATIONS: readonly DemoConversation[] = [
  {
    id: "caso-0142",
    title: "Caso 0142 · Factura de servicios",
    participants: ["vera", "kael", "nova"],
    preview: "Vera: la fuente quedó registrada; falta confirmar un campo.",
    activity: "hace 4 min",
    unread: 2,
  },
  {
    id: "caso-0139",
    title: "Caso 0139 · Contrato anual",
    participants: ["vera", "kael"],
    preview: "Kael: la evaluación de reglas llega en un bloque posterior.",
    activity: "hace 1 h",
    unread: 0,
  },
  {
    id: "caso-0131",
    title: "Caso 0131 · Revisión de proveedor",
    participants: ["vera", "nova"],
    preview: "Nova: presupuesto del periodo aún no configurado.",
    activity: "ayer",
    unread: 0,
  },
  {
    id: "equipo",
    title: "Equipo AP · Coordinación",
    participants: ["vera", "kael", "nova"],
    preview: "Vera: queda una incertidumbre marcada para revisión humana.",
    activity: "ayer",
    unread: 0,
  },
] as const

export const DEMO_THREAD: readonly DemoMessage[] = [
  {
    id: "m1",
    author: "user",
    at: "09:12",
    parts: [
      {
        kind: "text",
        text: "Adjunto la factura sintética del caso 0142. Revisen la evidencia antes de cualquier evaluación.",
      },
    ],
  },
  {
    id: "m2",
    author: "vera",
    at: "09:12",
    parts: [
      {
        kind: "tool",
        id: "t1",
        name: "registrar_fuente",
        summary: "Fuente registrada con hash SHA-256",
        status: "completed",
        detail:
          "Bytes recibidos y conservados de forma inmutable. Canal: PDF. El artefacto queda fuera del modelo; solo se exponen los campos observados.",
      },
      {
        kind: "text",
        text: "Registré la fuente y extraje los campos observados. Ojo: un campo quedó marcado como incertidumbre y no debe tratarse como verificado.",
      },
    ],
  },
  {
    id: "m3",
    author: "vera",
    at: "09:13",
    parts: [
      {
        kind: "tool",
        id: "t2",
        name: "leer_evidencia",
        summary: "Evidencia lista con citas verificadas",
        status: "completed",
        detail:
          "Campos expuestos con su referencia de evidencia. Los identificadores de cuenta se muestran enmascarados.",
      },
      {
        kind: "tool",
        id: "t3",
        name: "revisar_campo",
        summary: "Campo con baja confianza: fecha de vencimiento",
        status: "review",
        detail:
          "El extractor no pudo confirmar la fecha contra una segunda referencia. Esto es un estado de evidencia, no una decisión financiera.",
      },
    ],
  },
  {
    id: "m4",
    author: "kael",
    at: "09:14",
    parts: [
      {
        kind: "text",
        text: "Puedo explicar las seis reglas cuando exista una evaluación de L2. En este bloque todavía no hay kernel conectado, así que no voy a presentar un resultado como si lo fuera.",
      },
    ],
  },
  {
    id: "m5",
    author: "nova",
    at: "09:14",
    parts: [
      {
        kind: "text",
        text: "El presupuesto del periodo aún no está configurado en este entorno. No hay compromisos simulados que mostrar todavía.",
      },
    ],
  },
] as const

/** Reply appended by the programmed demo when the composer sends a message. */
export const DEMO_SCRIPTED_REPLY: readonly DemoMessage[] = [
  {
    id: "demo-tool",
    author: "vera",
    at: "",
    parts: [
      {
        kind: "tool",
        id: "demo-t1",
        name: "registrar_fuente",
        summary: "Registrando fuente…",
        status: "running",
      },
    ],
  },
  {
    id: "demo-text",
    author: "vera",
    at: "",
    parts: [
      {
        kind: "text",
        text: "Recibido. En modo demo no hay proveedor conectado: esta respuesta es programada y no ejecuta procesamiento real.",
      },
    ],
  },
] as const

export function getSpecialist(id: SpecialistId): Specialist {
  const found = SPECIALISTS.find((s) => s.id === id)
  if (!found) throw new Error(`Unknown specialist: ${id}`)
  return found
}

export function getConversation(id: string): DemoConversation | null {
  return DEMO_CONVERSATIONS.find((c) => c.id === id) ?? null
}

/**
 * Programmed thread per conversation. Every thread is synthetic; the case-0142
 * thread is the richer example, the rest are short placeholders so the UI never
 * pretends that two cases share one history.
 */
export function getDemoThread(conversationId: string): readonly DemoMessage[] {
  if (conversationId === "caso-0142") return DEMO_THREAD
  const conversation = getConversation(conversationId)
  return [
    {
      id: "placeholder-1",
      author: "user",
      at: "09:00",
      parts: [
        {
          kind: "text",
          text: `Hilo programado de ejemplo para «${conversation?.title ?? conversationId}».`,
        },
      ],
    },
    {
      id: "placeholder-2",
      author: conversation?.participants[0] ?? "vera",
      at: "09:00",
      parts: [
        {
          kind: "text",
          text: "En este bloque la conversación no ejecuta nada: solo demuestra el frame, los estados y el compositor.",
        },
      ],
    },
  ]
}
