import { createHash } from "node:crypto"

interface MigrationConnection {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export const WORKSPACE_MIGRATION = "0001_conversations"

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex")
}

/** Explicit CLI only. The web process never creates schemas or tables. */
export async function applyWorkspaceMigration(
  connection: MigrationConnection,
  sql: string,
  version: string = WORKSPACE_MIGRATION
): Promise<"applied" | "already-applied"> {
  const checksum = migrationChecksum(sql)
  await connection.query("BEGIN")
  try {
    await connection.query("SET LOCAL lock_timeout = '5s'")
    await connection.query("SELECT pg_advisory_xact_lock(728214762)")
    await connection.query("CREATE SCHEMA IF NOT EXISTS praeco_workspace")
    await connection.query(`CREATE TABLE IF NOT EXISTS praeco_workspace.schema_migrations (
      version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    const result = await connection.query(
      "SELECT checksum FROM praeco_workspace.schema_migrations WHERE version = $1",
      [version]
    )
    if (result.rows.length > 0) {
      if (result.rows[0].checksum !== checksum) throw new Error("WORKSPACE_MIGRATION_CHECKSUM_MISMATCH")
      await connection.query("COMMIT")
      return "already-applied"
    }
    await connection.query(sql)
    await connection.query(
      "INSERT INTO praeco_workspace.schema_migrations (version, checksum) VALUES ($1, $2)",
      [version, checksum]
    )
    await connection.query("COMMIT")
    return "applied"
  } catch (error) {
    await connection.query("ROLLBACK")
    // No SQL, parameters, connection URLs or original causes in errors.
    throw new Error(error instanceof Error && error.message === "WORKSPACE_MIGRATION_CHECKSUM_MISMATCH"
      ? error.message : "WORKSPACE_MIGRATION_FAILED")
  }
}
