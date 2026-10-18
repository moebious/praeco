import { z } from "zod"

import type { SpecialistId } from "@/lib/demo-data"

export const SPECIALIST_PROFILE_VERSION = 1
export const specialistIdSchema = z.enum(["vera", "kael", "nova"])
export const conversationIdSchema = z.uuid()
export const openConversationInput = z.object({ specialistId: specialistIdSchema }).strict()
export const renameConversationInput = z.object({
  conversationId: conversationIdSchema,
  title: z.string().trim().min(1).max(120),
}).strict()

export interface ConversationScope {
  readonly tenantId: string
  readonly userId: string
}

export interface ConversationMetadata {
  readonly id: string
  readonly specialistId: SpecialistId
  readonly profileVersion: number
  readonly title: string
  readonly preview: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Deliberately excludes owner/tenant IDs and any provider configuration. */
export interface ConversationSummary {
  readonly id: string
  readonly title: string
  readonly participants: readonly SpecialistId[]
  readonly preview: string
  readonly activity: string
  readonly unread: number
}

export interface ConversationStore {
  initialize(scope: ConversationScope): Promise<readonly ConversationMetadata[]>
  list(scope: ConversationScope): Promise<readonly ConversationMetadata[]>
  get(scope: ConversationScope, id: string): Promise<ConversationMetadata | null>
  rename(scope: ConversationScope, id: string, title: string): Promise<ConversationMetadata | null>
}

export type MetadataErrorCode =
  | "DATABASE_NOT_CONFIGURED"
  | "DATABASE_SCHEMA_MISSING"
  | "DATABASE_UNAVAILABLE"
  | "CONVERSATION_NOT_FOUND"
  | "INVALID_CONVERSATION_INPUT"

export class WorkspaceMetadataError extends Error {
  constructor(readonly code: MetadataErrorCode) {
    super(code)
    this.name = "WorkspaceMetadataError"
  }
}

export function metadataFailure(error: unknown): WorkspaceMetadataError {
  if (error instanceof WorkspaceMetadataError) return error
  // Drizzle wraps driver errors. Inspect only SQLSTATE, never expose its cause.
  const driverError = error && typeof error === "object" && "cause" in error ? error.cause : error
  const code = driverError && typeof driverError === "object" && "code" in driverError
    ? driverError.code : undefined
  return new WorkspaceMetadataError(
    code === "42P01" || code === "3F000" ? "DATABASE_SCHEMA_MISSING" : "DATABASE_UNAVAILABLE"
  )
}

export function summarizeConversation(conversation: ConversationMetadata): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    participants: [conversation.specialistId],
    preview: conversation.preview,
    activity: new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeZone: "UTC" })
      .format(new Date(conversation.updatedAt)),
    unread: 0,
  }
}
