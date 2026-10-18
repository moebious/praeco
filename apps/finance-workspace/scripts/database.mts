import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { TLSSocket } from "node:tls"
import { Client } from "pg"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"

import { createWorkspacePool } from "../db/connection"
import { createConversationStore } from "../db/conversation-store"
import { applyWorkspaceMigration, WORKSPACE_MIGRATION } from "../db/migrate"
import * as schema from "../db/schema"
import { WorkspaceMetadataError } from "../lib/conversations"

const [command, ...flags] = process.argv.slice(2)
const canWrite = flags.includes("--apply") && flags.includes("--schema=praeco_workspace")

async function smoke() {
  const scope = { tenantId: `smoke:${randomUUID()}`, userId: `smoke:${randomUUID()}` }
  const firstPool = createWorkspacePool()
  let secondPool: ReturnType<typeof createWorkspacePool> | undefined
  let firstClosed = false
  try {
    const firstStore = createConversationStore(drizzle(firstPool, { schema }))
    const initial = await firstStore.initialize(scope)
    const repeated = await firstStore.initialize(scope)
    if (initial.length !== 3 ||
        initial.map((row) => row.id).sort().join() !== repeated.map((row) => row.id).sort().join()) {
      throw new Error("WORKSPACE_SMOKE_IDEMPOTENCY_FAILED")
    }
    const selected = initial[0]
    await firstStore.rename(scope, selected.id, "Synthetic Neon persistence check")
    await firstPool.end()
    firstClosed = true

    secondPool = createWorkspacePool()
    const secondStore = createConversationStore(drizzle(secondPool, { schema }))
    const restored = await secondStore.get(scope, selected.id)
    if (restored?.title !== "Synthetic Neon persistence check") {
      throw new Error("WORKSPACE_SMOKE_PERSISTENCE_FAILED")
    }
    const otherUser = { ...scope, userId: `smoke:${randomUUID()}` }
    const otherTenant = { ...scope, tenantId: `smoke:${randomUUID()}` }
    for (const outsider of [otherUser, otherTenant]) {
      if (await secondStore.get(outsider, selected.id) !== null ||
          await secondStore.rename(outsider, selected.id, "Must not change") !== null) {
        throw new Error("WORKSPACE_SMOKE_ISOLATION_FAILED")
      }
    }
    console.log("PASS: three stable conversations, repeat initialization, new-connection persistence, and user/tenant isolation.")
  } finally {
    const cleanupPool = secondPool ?? (firstClosed ? createWorkspacePool() : firstPool)
    try {
      await drizzle(cleanupPool).delete(schema.conversations).where(and(
        eq(schema.conversations.tenantId, scope.tenantId),
        eq(schema.conversations.ownerUserId, scope.userId)
      ))
      console.log("Synthetic smoke rows removed.")
    } finally {
      await cleanupPool.end()
      if (cleanupPool !== firstPool && !firstClosed) await firstPool.end()
    }
  }
}

async function main() {
  if (!["status", "migrate", "smoke"].includes(command)) {
    throw new Error("Use status, migrate, or smoke.")
  }
  if (command !== "status" && !canWrite) {
    throw new Error("Writes require --apply --schema=praeco_workspace after confirming the development target.")
  }
  if (command === "smoke") return smoke()

  const pool = createWorkspacePool()
  try {
    const client = await pool.connect()
    try {
      if (command === "status") {
        const result = await client.query(`SELECT
          to_regclass('praeco_workspace.conversations') IS NOT NULL AS metadata_ready,
          to_regclass('praeco_workspace.chat_usage') IS NOT NULL AS chat_ready`)
        // Neon terminates TLS at its proxy, so pg_stat_ssl on the backend is
        // not evidence of the client transport. Inspect our own verified socket.
        const stream = client instanceof Client ? client.connection.stream : undefined
        const verifiedTLS = stream instanceof TLSSocket && stream.encrypted && stream.authorized
        console.log(JSON.stringify({ schema: "praeco_workspace", ...result.rows[0], verifiedTLS }))
      } else {
        for (const version of [WORKSPACE_MIGRATION, "0002_chat_inference"]) {
          const sql = await readFile(new URL(`../db/migrations/${version}.sql`, import.meta.url), "utf8")
          const outcome = await applyWorkspaceMigration(client, sql, version)
          console.log(JSON.stringify({ schema: "praeco_workspace", migration: version, outcome }))
        }
      }
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  const known = error instanceof WorkspaceMetadataError ? error.code
    : error instanceof Error && /^(WORKSPACE_[A-Z_]+|Writes require .*|Use status, migrate, or smoke\.)$/.test(error.message)
      ? error.message : "DATABASE_OPERATION_FAILED"
  console.error(known)
  process.exitCode = 1
}
