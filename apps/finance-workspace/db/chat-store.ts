import "server-only"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import * as schema from "@/db/schema"
import {
  CHAT_LEASE_SECONDS, nanosToUsd, usdToNanos, WorkspaceChatError,
  type UsageSummary,
} from "@/lib/chat/contracts"
import type { ConversationScope } from "@/lib/conversations"
import { getWorkspaceDatabase } from "@/db/connection"

export function createChatStore<T extends PgQueryResultHKT>(database: PgDatabase<T, typeof schema>) {
  const { conversations, chatAccess, chatUsage } = schema
  return {
    async authorize(scope: ConversationScope, id: string, maxCalls = 20) {
      const [conversation] = await database.select({ id: conversations.id }).from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, scope.tenantId),
          eq(conversations.ownerUserId, scope.userId)))
      if (!conversation) throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
      const expiresAt = new Date(Date.now() + CHAT_LEASE_SECONDS * 1000).toISOString()
      await database.insert(chatAccess).values({
        conversationId: id, bindingId: randomUUID(), expiresAt, maxCalls,
      })
        .onConflictDoUpdate({ target: chatAccess.conversationId, set: { expiresAt } })
      const [access] = await database.select().from(chatAccess).where(eq(chatAccess.conversationId, id))
      return access
    },
    async attachSession(id: string, sessionId: string) {
      await database.update(chatAccess).set({ sessionId }).where(eq(chatAccess.conversationId, id))
    },
    async session(scope: ConversationScope, id: string) {
      const [record] = await database.select({ sessionId: chatAccess.sessionId }).from(chatAccess)
        .innerJoin(conversations, eq(conversations.id, chatAccess.conversationId))
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, scope.tenantId),
          eq(conversations.ownerUserId, scope.userId)))
      return record?.sessionId ?? null
    },
    async bootstrap(scope: ConversationScope, id: string) {
      const [record] = await database.select({
        bindingId: chatAccess.bindingId, sessionId: chatAccess.sessionId,
      }).from(chatAccess).innerJoin(conversations, eq(conversations.id, chatAccess.conversationId))
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, scope.tenantId),
          eq(conversations.ownerUserId, scope.userId)))
      if (!record) throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
      return record
    },
    /** Worker-only read: the lease was granted by a separately authenticated action. */
    async context(id: string, bindingId: string) {
      const [context] = await database.select({
        id: conversations.id, tenantId: conversations.tenantId, userId: conversations.ownerUserId,
        specialistId: conversations.specialistId, expiresAt: chatAccess.expiresAt,
        sessionId: chatAccess.sessionId, bindingId: chatAccess.bindingId,
      }).from(conversations).innerJoin(chatAccess, eq(conversations.id, chatAccess.conversationId))
        .where(eq(conversations.id, id))
      if (!context || new Date(context.expiresAt).getTime() <= Date.now() ||
          context.bindingId !== bindingId) {
        throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
      }
      return context
    },
    async reserve(id: string, requestKey: string, model: string, reservedUsd: string) {
      return database.transaction(async (transaction) => {
        const [access] = await transaction.select().from(chatAccess)
          .where(eq(chatAccess.conversationId, id)).for("update")
        if (!access || new Date(access.expiresAt).getTime() <= Date.now()) {
          throw new WorkspaceChatError("CHAT_ACCESS_DENIED")
        }
        const calls = await transaction.select().from(chatUsage).where(eq(chatUsage.conversationId, id))
        if (calls.some((call) => call.requestKey === requestKey)) {
          throw new WorkspaceChatError("CHAT_DUPLICATE_CALL")
        }
        if (calls.some((call) => call.status === "reserved")) throw new WorkspaceChatError("CHAT_BUSY")
        if (calls.some((call) => call.status === "unknown")) throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
        const committed = calls.reduce((sum, call) =>
          sum + usdToNanos(call.actualUsd ?? call.reservedUsd), 0n)
        if (calls.length >= access.maxCalls ||
            committed + usdToNanos(reservedUsd) > usdToNanos(access.budgetUsd)) {
          throw new WorkspaceChatError("CHAT_BUDGET_EXHAUSTED")
        }
        const reservationId = randomUUID()
        await transaction.insert(chatUsage).values({
          id: reservationId, conversationId: id, requestKey, model, status: "reserved", reservedUsd,
        })
        return reservationId
      })
    },
    async complete(reservationId: string, usage: UsageSummary, reportedUsage: Record<string, unknown>) {
      const changed = await database.update(chatUsage).set({
        status: "completed", actualUsd: nanosToUsd(usdToNanos(usage.costUsd)),
        provider: usage.provider, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        reportedUsage,
      }).where(and(eq(chatUsage.id, reservationId), eq(chatUsage.status, "reserved")))
        .returning({ id: chatUsage.id })
      if (changed.length !== 1) throw new WorkspaceChatError("CHAT_COST_UNKNOWN")
    },
    async unknown(reservationId: string) {
      await database.update(chatUsage).set({ status: "unknown" })
        .where(and(eq(chatUsage.id, reservationId), eq(chatUsage.status, "reserved")))
    },
    async usage(id: string) {
      return database.select({
        model: chatUsage.model, provider: chatUsage.provider, status: chatUsage.status,
        actualUsd: chatUsage.actualUsd, reservedUsd: chatUsage.reservedUsd,
        inputTokens: chatUsage.inputTokens, outputTokens: chatUsage.outputTokens,
      }).from(chatUsage).where(eq(chatUsage.conversationId, id))
    },
    async preview(id: string, text: string) {
      await database.update(conversations).set({
        preview: text.slice(0, 120), updatedAt: new Date().toISOString(),
      }).where(eq(conversations.id, id))
    },
  }
}

export function getChatStore() { return createChatStore(getWorkspaceDatabase()) }
