import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { createConversationStore } from "@/db/conversation-store"
import { createChatStore } from "@/db/chat-store"
import { applyWorkspaceMigration } from "@/db/migrate"
import { workspacePoolConfiguration } from "@/db/connection"
import * as schema from "@/db/schema"
import { metadataFailure, summarizeConversation } from "@/lib/conversations"

const client = new PGlite()
const database = drizzle(client, { schema })
const migration = readFileSync(new URL("../db/migrations/0001_conversations.sql", import.meta.url), "utf8")
const chatMigration = readFileSync(new URL("../db/migrations/0002_chat_inference.sql", import.meta.url), "utf8")
const bindingMigration = readFileSync(new URL("../db/migrations/0003_chat_worker_binding.sql", import.meta.url), "utf8")
const migrationConnection = {
  async query(sql: string, parameters?: unknown[]) {
    // PGlite's prepared query API accepts one statement; exec matches pg's
    // parameter-free migration batch behavior, still inside the transaction.
    if (sql === migration || sql === chatMigration || sql === bindingMigration) {
      await client.exec(sql)
      return { rows: [] }
    }
    return client.query<Record<string, unknown>>(sql, parameters)
  },
}
const scope = { tenantId: "org:synthetic-a", userId: "user_synthetic-a" }
const store = createConversationStore(database)
const chatStore = createChatStore(database)

beforeAll(async () => {
  await applyWorkspaceMigration(migrationConnection, migration)
  await applyWorkspaceMigration(migrationConnection, chatMigration, "0002_chat_inference")
  await applyWorkspaceMigration(migrationConnection, bindingMigration, "0003_chat_worker_binding")
// Initial WASM compilation can be slow on a shared development host.
}, 120_000)
beforeEach(async () => {
  await client.exec("DELETE FROM praeco_workspace.conversations")
})

describe("Trigger chat leases and inference budgets, separate from the financial ledger", () => {
  async function authorizedConversation(maxCalls = 20) {
    const [conversation] = await store.initialize(scope)
    const access = await chatStore.authorize(scope, conversation.id, maxCalls)
    return { id: conversation.id, bindingId: access.bindingId }
  }

  it("requires the authenticated tenant and owner before granting a worker binding", async () => {
    const [conversation] = await store.initialize(scope)
    await expect(chatStore.authorize({ ...scope, userId: "user-other" }, conversation.id))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" })
    await expect(chatStore.authorize({ ...scope, tenantId: "tenant-other" }, conversation.id))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" })
  })

  it("binds worker context to an unguessable server-issued lease", async () => {
    const { id, bindingId } = await authorizedConversation()
    expect((await chatStore.context(id, bindingId)).userId).toBe(scope.userId)
    await expect(chatStore.context(id, randomUUID())).rejects.toMatchObject({
      code: "CHAT_ACCESS_DENIED",
    })
  })

  it("keeps message metadata separate and records model usage under the same schema", async () => {
    const { id } = await authorizedConversation()
    const reservation = await chatStore.reserve(id, "message-1:0", "synthetic/model", "0.01")
    await chatStore.complete(reservation, {
      model: "synthetic/model", provider: "synthetic", costUsd: "0.000012",
      inputTokens: 10, outputTokens: 3,
    }, { cost: 0.000012, reasoning_tokens: 0, cached_tokens: 0 })
    const [usage] = await chatStore.usage(id)
    expect(usage).toMatchObject({
      model: "synthetic/model", provider: "synthetic", status: "completed",
      actualUsd: "0.000012000", inputTokens: 10, outputTokens: 3,
    })
    expect((await store.list(scope))[0].preview).not.toContain("0.000012")
  })

  it("uses exact decimal reservation arithmetic and blocks spending beyond five cents", async () => {
    const { id } = await authorizedConversation()
    const reservation = await chatStore.reserve(id, "message-1:0", "synthetic/model", "0.04")
    await chatStore.complete(reservation, {
      model: "synthetic/model", provider: "synthetic", costUsd: "0.030000001",
      inputTokens: 10, outputTokens: 3,
    }, { cost: 0.030000001 })
    await expect(chatStore.reserve(id, "message-2:0", "synthetic/model", "0.02"))
      .rejects.toMatchObject({ code: "CHAT_BUDGET_EXHAUSTED" })
  })

  it("serializes concurrent reservations and retains unknown costs as blocking holds", async () => {
    const { id } = await authorizedConversation(3)
    const concurrent = await Promise.allSettled([
      chatStore.reserve(id, "message-a:0", "synthetic/model", "0.04"),
      chatStore.reserve(id, "message-b:0", "synthetic/model", "0.04"),
    ])
    const [reservation] = concurrent.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof chatStore.reserve>>> =>
      result.status === "fulfilled")
    if (!reservation) throw new Error("Expected fulfilled reservation")
    await chatStore.unknown(reservation.value)
    const recreated = createChatStore(drizzle(client, { schema }))
    await expect(recreated.reserve(id, "message-c:0", "synthetic/model", "0.001"))
      .rejects.toMatchObject({ code: "CHAT_COST_UNKNOWN" })
  })

  it("keeps a single-call limit when authorization tokens are renewed", async () => {
    const { id } = await authorizedConversation(1)
    const reservation = await chatStore.reserve(id, "message-1:0", "synthetic/model", "0.01")
    await chatStore.complete(reservation, {
      model: "synthetic/model", provider: "synthetic", costUsd: "0.001",
      inputTokens: 10, outputTokens: 3,
    }, { cost: 0.001 })
    await chatStore.authorize(scope, id, 20)
    await expect(chatStore.reserve(id, "message-2:0", "synthetic/model", "0.001"))
      .rejects.toMatchObject({ code: "CHAT_BUDGET_EXHAUSTED" })
  })

  it("replays chat migration checksums without touching receipt rows", async () => {
    const { id } = await authorizedConversation()
    await chatStore.reserve(id, "message-1:0", "synthetic/model", "0.01")
    await expect(applyWorkspaceMigration(migrationConnection, chatMigration, "0002_chat_inference"))
      .resolves.toBe("already-applied")
    expect((await chatStore.usage(id))[0].reservedUsd).toBe("0.010000000")
  })
})
afterAll(async () => { await client.close() })

describe("offline PostgreSQL conversation metadata", () => {
  it("seeds exactly three versioned profiles with stable IDs on repeated initialization", async () => {
    const first = await store.initialize(scope)
    const second = await store.initialize(scope)
    expect(first).toHaveLength(3)
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id))
    expect(first.map((row) => row.specialistId).sort()).toEqual(["kael", "nova", "vera"])
    expect(first.every((row) => row.profileVersion === 1)).toBe(true)
    expect(first.every((row) => !("tenantId" in row) && !("ownerUserId" in row))).toBe(true)
  })

  it("does not duplicate conversations under concurrent initialization", async () => {
    await Promise.all([store.initialize(scope), store.initialize(scope), store.initialize(scope)])
    expect(await store.list(scope)).toHaveLength(3)
  })

  it("keeps metadata when the store instance is recreated", async () => {
    const [first] = await store.initialize(scope)
    await store.rename(scope, first.id, "  Título sintético persistido  ")
    const recreated = createConversationStore(drizzle(client, { schema }))
    const restored = await recreated.get(scope, first.id)
    expect(restored?.title).toBe("Título sintético persistido")
    await recreated.initialize(scope)
    expect((await recreated.get(scope, first.id))?.title).toBe("Título sintético persistido")
  })

  it.each([
    { tenantId: "org:synthetic-a", userId: "user_synthetic-b" },
    { tenantId: "org:synthetic-b", userId: "user_synthetic-a" },
  ])("denies reads and writes for an unauthorized user or tenant", async (outsider) => {
    const [first] = await store.initialize(scope)
    expect(await store.get(outsider, first.id)).toBeNull()
    expect(await store.list(outsider)).toEqual([])
    expect(await store.rename(outsider, first.id, "Untrusted rename")).toBeNull()
    expect((await store.get(scope, first.id))?.title).toBe(first.title)
    const independent = await store.initialize(outsider)
    expect(independent).toHaveLength(3)
    expect(independent.some((row) => row.id === first.id)).toBe(false)
  })

  it("treats SQL-shaped titles as data without changing other rows", async () => {
    const [first] = await store.initialize(scope)
    const title = "Synthetic '); DELETE FROM praeco_workspace.conversations; --"
    expect((await store.rename(scope, first.id, title))?.title).toBe(title)
    expect(await store.list(scope)).toHaveLength(3)
  })

  it("fails closed for malformed IDs, titles, and empty identity scope", async () => {
    await store.initialize(scope)
    expect(await store.get(scope, "' OR 1=1 --")).toBeNull()
    expect(await store.get(scope, randomUUID())).toBeNull()
    await expect(store.rename(scope, randomUUID(), " ")).rejects.toMatchObject({
      code: "INVALID_CONVERSATION_INPUT",
    })
    await expect(store.list({ ...scope, tenantId: "" })).rejects.toMatchObject({
      code: "INVALID_CONVERSATION_INPUT",
    })
  })

  it("keeps ownership and provider data out of client summaries", async () => {
    const [first] = await store.initialize(scope)
    expect(Object.keys(summarizeConversation(first)).sort()).toEqual(
      ["activity", "id", "participants", "preview", "title", "unread"]
    )
  })
})

describe("versioned migration and operational boundaries", () => {
  it("replays an unchanged migration without dropping data", async () => {
    await store.initialize(scope)
    expect(await applyWorkspaceMigration(migrationConnection, migration)).toBe("already-applied")
    expect(await store.list(scope)).toHaveLength(3)
  })

  it("rejects checksum drift while retaining existing metadata", async () => {
    await store.initialize(scope)
    await expect(applyWorkspaceMigration(migrationConnection, `${migration}\n-- altered`))
      .rejects.toThrow("WORKSPACE_MIGRATION_CHECKSUM_MISMATCH")
    expect(await store.list(scope)).toHaveLength(3)
  })

  it("enforces the allowed profiles at the database boundary", async () => {
    await expect(client.query(`INSERT INTO praeco_workspace.conversations
      (id, tenant_id, owner_user_id, specialist_id, profile_version, title, preview)
      VALUES ($1, $2, $3, $4, 1, 'Synthetic', '')`,
    [randomUUID(), scope.tenantId, scope.userId, "unknown-profile"])).rejects.toThrow()
  })

  it("retains TLS verification and bounds remote connection resources", () => {
    const configuration = workspacePoolConfiguration("postgres://synthetic:synthetic@db.example.test/workspace?sslmode=require")
    expect(new URL(configuration.connectionString!).searchParams.get("sslmode")).toBe("verify-full")
    expect(configuration.max).toBe(4)
    expect(configuration.connectionTimeoutMillis).toBe(5_000)
    expect(configuration.statement_timeout).toBe(10_000)
    expect(configuration).not.toHaveProperty("ssl", { rejectUnauthorized: false })
  })

  it("reports schema failures without database error content", () => {
    const error = metadataFailure({ cause: { code: "42P01", message: "synthetic-secret" } })
    expect(error.code).toBe("DATABASE_SCHEMA_MISSING")
    expect(error.message).not.toContain("synthetic-secret")
    expect(error.cause).toBeUndefined()
  })
})
