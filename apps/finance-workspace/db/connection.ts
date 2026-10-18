import "server-only"

import { Pool, type PoolConfig } from "pg"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/db/schema"
import { createConversationStore } from "@/db/conversation-store"
import { WorkspaceMetadataError, type ConversationStore } from "@/lib/conversations"
import { prepareServerEnvironment, readServiceConfig } from "@/lib/server-env"

export function workspacePoolConfiguration(connectionString: string): PoolConfig {
  const url = new URL(connectionString)
  // Keep certificate verification on for Neon/remote PostgreSQL. Local test
  // databases may explicitly use sslmode=disable; no hosted fallback is allowed.
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    url.searchParams.set("sslmode", "verify-full")
  }
  return {
    connectionString: url.toString(),
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    application_name: "praeco-finance-workspace",
    allowExitOnIdle: true,
  }
}

export function createWorkspacePool(): Pool {
  prepareServerEnvironment()
  const configuration = readServiceConfig("database")
  if (!configuration.ok) throw new WorkspaceMetadataError("DATABASE_NOT_CONFIGURED")
  const pool = new Pool(workspacePoolConfiguration(configuration.values.DATABASE_URL))
  // Idle connection errors must not crash the process or print connection data.
  // Active query errors are reported through the sanitized store boundary.
  pool.on("error", () => {})
  return pool
}

const processResources = globalThis as typeof globalThis & {
  praecoConversationStore?: ConversationStore
  praecoWorkspaceDatabase?: NodePgDatabase<typeof schema>
}

export function getWorkspaceDatabase(): NodePgDatabase<typeof schema> {
  if (!processResources.praecoWorkspaceDatabase) {
    processResources.praecoWorkspaceDatabase = drizzle(createWorkspacePool(), { schema })
  }
  return processResources.praecoWorkspaceDatabase
}

/** Lazy singleton, including dev reloads. Importing this module connects nothing. */
export function getConversationStore(): ConversationStore {
  if (!processResources.praecoConversationStore) {
    processResources.praecoConversationStore = createConversationStore(getWorkspaceDatabase())
  }
  return processResources.praecoConversationStore
}
