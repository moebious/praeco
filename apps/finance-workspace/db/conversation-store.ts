import "server-only"

import { randomUUID } from "node:crypto"
import { and, asc, desc, eq } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"

import * as schema from "@/db/schema"
import {
  conversationIdSchema,
  metadataFailure,
  renameConversationInput,
  SPECIALIST_PROFILE_VERSION,
  WorkspaceMetadataError,
  type ConversationScope,
  type ConversationStore,
} from "@/lib/conversations"
import { SPECIALISTS } from "@/lib/demo-data"

const { conversations } = schema
const visibleColumns = {
  id: conversations.id,
  specialistId: conversations.specialistId,
  profileVersion: conversations.profileVersion,
  title: conversations.title,
  preview: conversations.preview,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
}

function ownership(scope: ConversationScope) {
  if (!scope.tenantId.trim() || !scope.userId.trim()) {
    throw new WorkspaceMetadataError("INVALID_CONVERSATION_INPUT")
  }
  return and(
    eq(conversations.tenantId, scope.tenantId),
    eq(conversations.ownerUserId, scope.userId)
  )
}

/** Both tenant and explicit user ownership are required on every read/write. */
export function createConversationStore<T extends PgQueryResultHKT>(
  database: PgDatabase<T, typeof schema>
): ConversationStore {
  const store: ConversationStore = {
    async initialize(scope) {
      ownership(scope)
      try {
        await database.insert(conversations).values(SPECIALISTS.map((specialist) => ({
          id: randomUUID(),
          tenantId: scope.tenantId,
          ownerUserId: scope.userId,
          specialistId: specialist.id,
          profileVersion: SPECIALIST_PROFILE_VERSION,
          title: `${specialist.name} · ${specialist.role}`,
          preview: "Sin mensajes persistidos. Chat real pendiente.",
        }))).onConflictDoNothing({
          target: [conversations.tenantId, conversations.ownerUserId, conversations.specialistId],
        })
        return await store.list(scope)
      } catch (error) {
        throw metadataFailure(error)
      }
    },
    async list(scope) {
      const filter = ownership(scope)
      try {
        return await database.select(visibleColumns).from(conversations).where(filter)
          .orderBy(desc(conversations.updatedAt), asc(conversations.id))
      } catch (error) {
        throw metadataFailure(error)
      }
    },
    async get(scope, id) {
      const filter = ownership(scope)
      if (!conversationIdSchema.safeParse(id).success) return null
      try {
        const [conversation] = await database.select(visibleColumns).from(conversations)
          .where(and(filter, eq(conversations.id, id))).limit(1)
        return conversation ?? null
      } catch (error) {
        throw metadataFailure(error)
      }
    },
    async rename(scope, id, title) {
      const filter = ownership(scope)
      const input = renameConversationInput.safeParse({ conversationId: id, title })
      if (!input.success) throw new WorkspaceMetadataError("INVALID_CONVERSATION_INPUT")
      try {
        const [conversation] = await database.update(conversations).set({
          title: input.data.title,
          updatedAt: new Date().toISOString(),
        }).where(and(filter, eq(conversations.id, id))).returning(visibleColumns)
        return conversation ?? null
      } catch (error) {
        throw metadataFailure(error)
      }
    },
  }
  return store
}
