import "server-only"
import { z } from "zod"
import { prepareServerEnvironment, type EnvironmentSource } from "@/lib/server-env"
import { WorkspaceChatError } from "@/lib/chat/contracts"

const chatConfiguration = z.object({
  OPENROUTER_API_KEY: z.string().trim().min(1),
  OPENROUTER_MODEL: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i),
  TRIGGER_PROJECT_REF: z.string().trim().regex(/^proj_[a-z0-9]+$/i),
  TRIGGER_SECRET_KEY: z.string().trim().regex(/^tr_dev_sk_\S+$/),
})

export function readChatConfiguration(source?: EnvironmentSource) {
  if (!source) prepareServerEnvironment()
  const result = chatConfiguration.safeParse(source ?? process.env)
  if (!result.success) throw new WorkspaceChatError("CHAT_NOT_CONFIGURED")
  return result.data
}

export function chatIsConfigured(): boolean {
  try { readChatConfiguration(); return true } catch { return false }
}
