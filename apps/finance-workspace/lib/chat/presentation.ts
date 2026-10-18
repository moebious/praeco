import type { WorkspaceChatMessage } from "@/lib/chat/contracts"
import type { DemoMessage, MessagePart, SpecialistId } from "@/lib/demo-data"

export function presentChatMessages(messages: readonly WorkspaceChatMessage[], specialistId: SpecialistId): DemoMessage[] {
  return messages.map((message) => ({
    id: message.id,
    author: message.role === "user" ? "user" : specialistId,
    at: "",
    parts: message.parts.flatMap((part, index): MessagePart[] => {
      if (part.type === "text") return [{ kind: "text", text: part.text }]
      if (part.type === "reasoning") return [{
        kind: "tool", id: `${message.id}-reasoning-${index}`, name: "razonamiento",
        summary: "Razonamiento del modelo", status: part.state === "streaming" ? "running" : "completed",
        detail: part.text,
      }]
      if (part.type === "data-usage") return [{
        kind: "tool", id: `${message.id}-usage-${index}`, name: "consumo_modelo",
        summary: `Consumo reportado: USD ${part.data.costUsd}`, status: "completed",
        detail: `${part.data.model} · ${part.data.provider}\nEntrada: ${part.data.inputTokens} tokens · Salida: ${part.data.outputTokens} tokens.\nEs coste de inferencia, no presupuesto financiero.`,
      }]
      if ("toolCallId" in part && "state" in part) {
        const completed = part.state === "output-available"
        const failed = part.state === "output-error" || part.state === "output-denied"
        return [{
          kind: "tool", id: String(part.toolCallId), name: part.type.replace(/^tool-/, ""),
          summary: failed ? "Herramienta no completada" : completed ? "Consulta de solo lectura completada" : "Consultando capacidades…",
          status: failed ? "error" : completed ? "completed" : "running",
          detail: completed && "output" in part ? JSON.stringify(part.output, null, 2).slice(0, 4000) : undefined,
        }]
      }
      return []
    }),
  }))
}

const errors: Record<string, string> = {
  CHAT_ACCESS_DENIED: "La sesión expiró o no tienes acceso. Vuelve a iniciar sesión.",
  CHAT_NOT_CONFIGURED: "Falta configurar OpenRouter o el worker Development de Trigger.",
  CHAT_CONTEXT_LIMIT: "La conversación alcanzó el límite de contexto de esta prueba.",
  CHAT_BUDGET_EXHAUSTED: "Se agotó el presupuesto de inferencia de esta conversación. No se harán más llamadas.",
  CHAT_BUSY: "Ya hay una llamada en curso o pendiente de conciliación. No se repetirá automáticamente.",
  CHAT_COST_UNKNOWN: "El proveedor no confirmó el coste. Se bloquearon nuevas llamadas hasta conciliarlo.",
  CHAT_DUPLICATE_CALL: "Esta solicitud ya fue enviada al proveedor. No se repetirá el gasto.",
  CHAT_INPUT_INVALID: "Envía solo texto sintético, con un máximo de 1.200 caracteres.",
}

export function chatErrorMessage(error: unknown): string {
  return error instanceof Error && errors[error.message] ? errors[error.message]
    : "No se pudo completar la conversación. Revisa la conexión y que el worker local esté activo; no hay reintentos automáticos."
}
