import { sql } from "drizzle-orm"
import { check, integer, jsonb, numeric, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

export const workspaceSchema = pgSchema("praeco_workspace")

export const conversations = workspaceSchema.table("conversations", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  specialistId: text("specialist_id", { enum: ["vera", "kael", "nova"] }).notNull(),
  profileVersion: integer("profile_version").notNull(),
  title: text("title").notNull(),
  preview: text("preview").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversations_owner_specialist_unique")
    .on(table.tenantId, table.ownerUserId, table.specialistId),
  check("conversations_specialist_check", sql`${table.specialistId} in ('vera', 'kael', 'nova')`),
  check("conversations_title_check", sql`length(btrim(${table.title})) between 1 and 120`),
  check("conversations_profile_version_check", sql`${table.profileVersion} > 0`),
])

export const chatAccess = workspaceSchema.table("chat_access", {
  conversationId: uuid("conversation_id").primaryKey().references(() => conversations.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull(),
  sessionId: text("session_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  budgetUsd: numeric("budget_usd", { precision: 20, scale: 9 }).notNull().default("0.05"),
  maxCalls: integer("max_calls").notNull().default(20),
}, (table) => [
  check("chat_access_budget_check", sql`${table.budgetUsd} > 0 and ${table.budgetUsd} <= 0.05`),
  check("chat_access_calls_check", sql`${table.maxCalls} between 1 and 20`),
])

export const chatUsage = workspaceSchema.table("chat_usage", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => chatAccess.conversationId, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull().default("OpenRouter"),
  status: text("status", { enum: ["reserved", "completed", "unknown"] }).notNull(),
  reservedUsd: numeric("reserved_usd", { precision: 20, scale: 9 }).notNull(),
  actualUsd: numeric("actual_usd", { precision: 20, scale: 9 }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  reportedUsage: jsonb("reported_usage").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("chat_usage_request_unique").on(table.conversationId, table.requestKey),
  check("chat_usage_status_check", sql`${table.status} in ('reserved', 'completed', 'unknown')`),
  check("chat_usage_reserved_check", sql`${table.reservedUsd} >= 0`),
  check("chat_usage_actual_check", sql`${table.actualUsd} >= 0`),
  check("chat_usage_completion_check", sql`${table.status} <> 'completed' or ${table.actualUsd} is not null`),
])
