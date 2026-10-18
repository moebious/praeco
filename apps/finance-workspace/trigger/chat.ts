import { chat } from "@trigger.dev/sdk/ai"
import { z } from "zod"
import { getChatStore } from "@/db/chat-store"
import {
  CHAT_TASK_ID, CHAT_TOKEN_TTL, chatClientDataSchema, safeChatError, WorkspaceChatError,
  type WorkspaceChatMessage,
} from "@/lib/chat/contracts"
import { runChatTurn } from "@/lib/chat/run-turn"
import { workspaceChatTools } from "@/lib/chat/tools"

const userMessage = z.object({
  id: z.string().min(1).max(160),
  role: z.literal("user"),
  parts: z.array(z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(1200) }).strict()).length(1),
}).strict()

const activeRequest = chat.local<{ id: string }>({ id: "praeco-workspace-request" })

export const workspaceChat = chat.withUIMessage<WorkspaceChatMessage>().withClientData({
  schema: chatClientDataSchema,
}).agent({
  id: CHAT_TASK_ID,
  tools: workspaceChatTools,
  system: "Eres Praeco, un asistente de operaciones financieras con datos sintéticos. " +
    "Cuentas con herramientas conectadas para consultar el catálogo de casos de cuentas por pagar (list_payable_cases), " +
    "inspeccionar evidencia L1 verificada (inspect_payable_case), evaluar preliminarmente las 6 compuertas del kernel L2 (evaluate_payable_policy), " +
    "ejecutar la autorización simulada en el kernel L2 (authorize_payable), y resolver aprobaciones pendientes (resolve_payable_approval). " +
    "Las decisiones financieras corresponden de manera exclusiva al kernel L2 determinista; nunca inventes cifras, compuertas ni estados. " +
    "Toda autorización es SIMULADA. Nunca declares 'PAID', 'PAGADO' o 'PAGÓ'; el desenlace autorizado es estrictamente 'AUTHORIZED_SIMULATED'. " +
    "Falla cerrado ante evidencia ausente o no verificada. " +
    "Explica las 6 compuertas con claridad (G1 integridad, G2 duplicados, G3 beneficiario, G4 contrato, G5 presupuesto, G6 umbral). " +
    "Nunca expongas números de cuenta bancaria de proveedores. " +
    "Responde siempre en el idioma del usuario y usa las herramientas según corresponda.",
  maxTurns: 20,
  turnTimeout: "10m",
  idleTimeoutInSeconds: 0,
  chatAccessTokenTTL: CHAT_TOKEN_TTL,
  onBoot: async ({ chatId, clientData }) => {
    activeRequest.init({ id: "" })
    await getChatStore().context(chatId, clientData.bindingId)
  },
  onTurnStart: ({ uiMessages }) => {
    const latest = [...uiMessages].reverse().find((message) => message.role === "user")
    if (!latest) throw new WorkspaceChatError("CHAT_INPUT_INVALID")
    activeRequest.id = latest.id
  },
  uiMessageStreamOptions: {
    sendReasoning: true,
    onError: (error) => safeChatError(error).code,
  },
  onValidateMessages: ({ messages }) => {
    if (!messages.every((message) => userMessage.safeParse(message).success)) {
      throw new WorkspaceChatError("CHAT_INPUT_INVALID")
    }
    return messages
  },
  prepareMessages: async ({ messages, chatId, clientData }) => {
    try {
      if (!clientData?.bindingId) throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
      const context = await getChatStore().context(chatId, clientData.bindingId)
      return [{ role: "system", content: `Perfil de presentación asignado por servidor: ${context.specialistId}. Este perfil no concede permisos.` }, ...messages]
    } catch (error) { throw safeChatError(error) }
  },
  run: async ({ chatId, clientData, messages, signal, streamText }) => {
    try {
      if (!clientData?.bindingId) throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
      return await runChatTurn({
        chatId, bindingId: clientData.bindingId, messages, signal, streamText, requestId: activeRequest.id,
        onUsage: (usage) => chat.response.write({ type: "data-usage", data: usage }),
      })
    } catch (error) { throw safeChatError(error) }
  },
  onTurnComplete: async ({ chatId, responseMessage }) => {
    try {
      const text = responseMessage?.parts.filter((part) => part.type === "text")
        .map((part) => part.text).join("") ?? ""
      if (text) await getChatStore().preview(chatId, text)
    } catch { throw new WorkspaceChatError("CHAT_UNAVAILABLE") }
  },
})
