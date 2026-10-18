import { z } from "zod"
import type { UIMessage } from "ai"

export const CHAT_TASK_ID = "praeco-workspace-chat"
export const CHAT_BUDGET_USD = "0.05"
export const CHAT_TOKEN_TTL = "1m"
export const CHAT_LEASE_SECONDS = 120
export const MAX_OUTPUT_TOKENS = 1024
export const MAX_CONTEXT_BYTES = 6000
export const MAX_STEPS = 2

export type ChatErrorCode =
  | "CHAT_NOT_CONFIGURED" | "CHAT_ACCESS_DENIED" | "CHAT_UNAVAILABLE"
  | "CHAT_INPUT_INVALID" | "CHAT_CONTEXT_LIMIT" | "CHAT_BUDGET_EXHAUSTED"
  | "CHAT_BUSY" | "CHAT_COST_UNKNOWN" | "CHAT_DUPLICATE_CALL"

export class WorkspaceChatError extends Error {
  constructor(readonly code: ChatErrorCode) {
    super(code)
    this.name = "WorkspaceChatError"
  }
}

export const chatIdInput = z.object({ chatId: z.uuid() }).strict()
export const transcriptInput = chatIdInput.extend({
  before: z.string().min(1).max(200).optional(),
}).strict()
export const emptyClientData = z.object({}).strict()

export interface UsageSummary {
  model: string
  provider: string
  costUsd: string
  inputTokens: number
  outputTokens: number
}
export type WorkspaceChatMessage = UIMessage<unknown, { usage: UsageSummary }>

/** Decimal arithmetic in billionths of USD, rounded up rather than undercharging. */
export function usdToNanos(value: string | number): bigint {
  if (String(value).length > 80) throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match) throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) {
    throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
  }
  const fractional = match[2] ?? ""
  const digits = BigInt(match[1] + fractional)
  const shift = 9 + exponent - fractional.length
  if (shift >= 0) return digits * 10n ** BigInt(shift)
  const divisor = 10n ** BigInt(-shift)
  return (digits + divisor - 1n) / divisor
}

export function nanosToUsd(value: bigint): string {
  return `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, "0")}`
}

export function safeChatError(error: unknown): WorkspaceChatError {
  return error instanceof WorkspaceChatError ? error : new WorkspaceChatError("CHAT_UNAVAILABLE")
}
