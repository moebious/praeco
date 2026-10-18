import "server-only"
import { z } from "zod"
import { prepareServerEnvironment, type EnvironmentSource } from "@/lib/server-env"
import { WorkspaceChatError } from "@/lib/chat/contracts"

const modelConfiguration = z.object({
  OPENROUTER_API_KEY: z.string().trim().min(1),
  OPENROUTER_MODEL: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i),
})
const chatConfiguration = modelConfiguration.extend({
  TRIGGER_PROJECT_REF: z.string().trim().regex(/^proj_[a-z0-9]+$/i),
  TRIGGER_SECRET_KEY: z.string().trim().regex(/^tr_dev_sk_\S+$/),
})

function configurationSource(source?: EnvironmentSource) {
  if (!source) prepareServerEnvironment()
  return source ?? process.env
}

export function readModelConfiguration(source?: EnvironmentSource) {
  const result = modelConfiguration.safeParse(configurationSource(source))
  if (!result.success) throw new WorkspaceChatError("CHAT_NOT_CONFIGURED")
  return result.data
}

/** Full server-side config, including Trigger credentials used only by control actions. */
export function readChatConfiguration(source?: EnvironmentSource) {
  const result = chatConfiguration.safeParse(configurationSource(source))
  if (!result.success) throw new WorkspaceChatError("CHAT_NOT_CONFIGURED")
  return result.data
}

export function chatIsConfigured(): boolean {
  try { readChatConfiguration(); return true } catch { return false }
}
