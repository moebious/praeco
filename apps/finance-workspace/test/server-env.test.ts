import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  WORKSPACE_ENV_FILE,
  WorkspaceConfigurationError,
  describeEnvironment,
  getEnvironmentLoadReport,
  loadWorkspaceEnvFile,
  parseEnvFile,
  prepareServerEnvironment,
  readServiceConfig,
  requireServiceConfig,
  type EnvironmentSource,
} from "@/lib/server-env"

const APP_ROOT = resolve(__dirname, "..")

const NEON_PASSWORD = "test-redaction-token"
const buildTestDatabaseUrl = (scheme: string) =>
  `${scheme}://demo_user:${NEON_PASSWORD}@db.example.test/neondb?sslmode=require`
const NEON_URL = buildTestDatabaseUrl("postgresql")
const CLERK_SECRET = "test-token-clerk"
const MODEL_KEY = "test-token-model"
const SANDBOX_KEY = "test-token-sandbox"

const CONFIGURED: EnvironmentSource = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_public",
  CLERK_SECRET_KEY: CLERK_SECRET,
  DATABASE_URL: NEON_URL,
  OPENROUTER_API_KEY: MODEL_KEY,
  DAYTONA_API_KEY: SANDBOX_KEY,
}

const SECRETS = [CLERK_SECRET, MODEL_KEY, SANDBOX_KEY, NEON_PASSWORD]

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "praeco-env-"))
  tempDirs.push(dir)
  return dir
}

function writeEnvFile(dir: string, name: string, contents: string): string {
  const path = join(dir, name)
  writeFileSync(path, contents, "utf8")
  return path
}

function makeRepository() {
  const root = makeTempDir()
  writeEnvFile(root, "package.json", '{"name":"praeco","private":true}')
  const app = join(root, "apps", "finance-workspace")
  mkdirSync(app, { recursive: true })
  writeEnvFile(app, "package.json", '{"name":"@praeco/finance-workspace"}')
  return { root, app }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Vendored registry components are licensed third-party sources, not our surface.
      if (relative(APP_ROOT, full) === join("components", "ui")) continue
      sourceFiles(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

describe("environment status", () => {
  it("declares the explicit demo mode when nothing is configured", () => {
    const status = describeEnvironment({})

    expect(status.mode).toBe("demo")
    expect(status.services.map((service) => service.service)).toEqual([
      "identity",
      "database",
      "inference",
      "sandbox",
    ])
    expect(status.services.map((service) => service.block)).toEqual(["B2", "B3", "B4", "B5"])
    expect(status.services.every((service) => service.state === "absent")).toBe(true)
    expect(status.invalid).toEqual([])
    expect(status.missing).toEqual([
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "DATABASE_URL",
      "OPENROUTER_API_KEY",
      "DAYTONA_API_KEY",
    ])
  })

  it("reports every declared service as ready without exposing values", () => {
    const status = describeEnvironment(CONFIGURED)

    expect(status.mode).toBe("configured")
    expect(status.services.every((service) => service.state === "ready")).toBe(true)
    expect(status.missing).toEqual([])
    expect(status.invalid).toEqual([])

    const serialized = JSON.stringify(status)
    for (const secret of SECRETS) expect(serialized).not.toContain(secret)
  })

  it("separates a missing variable from a malformed one", () => {
    const status = describeEnvironment({
      DATABASE_URL: buildTestDatabaseUrl("mysql"),
    })

    expect(status.invalid).toEqual(["DATABASE_URL"])
    expect(status.services.find((service) => service.service === "database")?.state).toBe("invalid")
    expect(status.services.find((service) => service.service === "inference")?.state).toBe("absent")
    expect(JSON.stringify(status)).not.toContain(NEON_PASSWORD)
  })

  it("marks a service with one of several variables as partial", () => {
    const status = describeEnvironment({ CLERK_SECRET_KEY: CLERK_SECRET })
    const identity = status.services.find((service) => service.service === "identity")

    expect(identity?.state).toBe("partial")
    expect(identity?.variables).toEqual([
      { name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", state: "missing" },
      { name: "CLERK_SECRET_KEY", state: "set" },
    ])
    expect(JSON.stringify(status)).not.toContain(CLERK_SECRET)
  })

  it("treats a whitespace-only value as undefined", () => {
    const status = describeEnvironment({ OPENROUTER_API_KEY: "   " })

    expect(status.mode).toBe("demo")
    expect(status.missing).toContain("OPENROUTER_API_KEY")
  })
})

describe("typed service access", () => {
  it("returns the values of a complete service", () => {
    const result = readServiceConfig("database", CONFIGURED)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.values.DATABASE_URL).toBe(NEON_URL)
  })

  it("fails closed with variable names instead of a value", () => {
    const thrown = (() => {
      try {
        requireServiceConfig("inference", {})
        return null
      } catch (error) {
        return error
      }
    })()

    expect(thrown).toBeInstanceOf(WorkspaceConfigurationError)
    const error = thrown as WorkspaceConfigurationError
    expect(error.service).toBe("inference")
    expect(error.missing).toEqual(["OPENROUTER_API_KEY"])
    expect(error.invalid).toEqual([])
    expect(error.message).toContain("OPENROUTER_API_KEY")
    expect(error.message).not.toContain(MODEL_KEY)
    // The original cause could carry the received content, so it is not attached.
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify({ message: error.message, missing: error.missing })).not.toContain(
      MODEL_KEY
    )
  })

  it("reports a malformed variable by name only", () => {
    const result = readServiceConfig("database", {
      DATABASE_URL: buildTestDatabaseUrl("mysql"),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.invalid).toEqual(["DATABASE_URL"])
      expect(result.missing).toEqual([])
      expect(JSON.stringify(result)).not.toContain(NEON_PASSWORD)
    }
  })
})

describe("env file parsing", () => {
  it("accepts quotes, spacing, export and comments without expanding variables", () => {
    const contents = [
      "# comment",
      "",
      "PLAIN=value",
      'DOUBLE_QUOTED="value with spaces"',
      "SINGLE_QUOTED='simple value'",
      "export EXPORTED=value",
      "  SPACED  =  value  ",
      "EMPTY=",
      "REFERENCE=$PLAIN",
      "NO_SEPARATOR",
      "1INVALID=x",
      "# OTHER=no",
    ].join("\n")

    expect(Object.fromEntries(parseEnvFile(contents))).toEqual({
      PLAIN: "value",
      DOUBLE_QUOTED: "value with spaces",
      SINGLE_QUOTED: "simple value",
      EXPORTED: "value",
      SPACED: "value",
      EMPTY: "",
      REFERENCE: "$PLAIN",
    })
  })

  it("preserves literal dollars, quoted multiline content, and inline comments", () => {
    expect(Object.fromEntries(parseEnvFile([
      "TOKEN='synthetic$literal#value'",
      "COMMENTED=value # not part of the value",
      'MULTILINE="first',
      'second"',
    ].join("\n")))).toEqual({
      TOKEN: "synthetic$literal#value",
      COMMENTED: "value",
      MULTILINE: "first\nsecond",
    })
  })
})

describe("single root env file", () => {
  it("keeps a missing local file optional for the offline demo", () => {
    const { app } = makeRepository()
    const source: EnvironmentSource = {}
    const report = loadWorkspaceEnvFile({ cwd: app, source })
    expect(report.files[0].error).toBe("unreadable")
    expect(report.applied).toEqual([])
    expect(describeEnvironment(source).mode).toBe("demo")
  })

  it("loads the root file without overriding process values, even empty ones", () => {
    const { root, app } = makeRepository()
    writeEnvFile(
      root,
      WORKSPACE_ENV_FILE,
      ["NEW=one", "EXISTING=new", "EMPTY=do-not-apply", "# comment", "OTHER=two"].join("\n")
    )
    const source: EnvironmentSource = { EXISTING: "original", EMPTY: "" }

    const report = loadWorkspaceEnvFile({ cwd: app, source })

    expect(report.files).toHaveLength(1)
    expect(report.files[0].applied).toEqual(["NEW", "OTHER"])
    expect(report.files[0].skipped).toEqual(["EMPTY", "EXISTING"])
    expect(report.applied).toEqual(["NEW", "OTHER"])
    expect(source).toEqual({ EXISTING: "original", EMPTY: "", NEW: "one", OTHER: "two" })
  })

  it("resolves the same file from root and workspace, ignoring an app-local file", () => {
    const { root, app } = makeRepository()
    writeEnvFile(root, WORKSPACE_ENV_FILE, "ROOT_ONLY=correct\n")
    writeEnvFile(app, WORKSPACE_ENV_FILE, "ROOT_ONLY=wrong\n")
    for (const cwd of [root, app]) {
      const source: EnvironmentSource = {}
      const report = loadWorkspaceEnvFile({ cwd, source })
      expect(report.files[0].resolved).toBe(join(root, WORKSPACE_ENV_FILE))
      expect(source).toEqual({ ROOT_ONLY: "correct" })
    }
  })

  it("never loads an unrelated directory's credentials", () => {
    const dir = makeTempDir()
    writeEnvFile(dir, WORKSPACE_ENV_FILE, "DO_NOT_READ=unrelated\n")
    const source: EnvironmentSource = {}
    expect(loadWorkspaceEnvFile({ cwd: dir, source })).toEqual({ files: [], applied: [] })
    expect(source).toEqual({})
  })

  it("does not follow legacy per-service files or reference lists", () => {
    const { root, app } = makeRepository()
    writeEnvFile(root, ".env.neon.local", "DATABASE_URL=do-not-read\n")
    const source: EnvironmentSource = {}
    loadWorkspaceEnvFile({ cwd: app, source })
    expect(source).toEqual({})
  })

  it("feeds the status reader without reporting credential content", () => {
    const { root, app } = makeRepository()
    writeEnvFile(root, WORKSPACE_ENV_FILE, "OPENROUTER_API_KEY=synthetic-local-value\n")
    const source: EnvironmentSource = {}
    const report = prepareServerEnvironment({ cwd: app, source })
    expect(describeEnvironment(source).mode).toBe("configured")
    expect(report.applied).toEqual(["OPENROUTER_API_KEY"])
    expect(JSON.stringify(report)).not.toContain("synthetic-local-value")
    expect(getEnvironmentLoadReport().files).toHaveLength(1)
  })

  it("retains literal dollar signs when applying values", () => {
    const { root } = makeRepository()
    writeEnvFile(root, WORKSPACE_ENV_FILE, "PASSWORD='synthetic$literal#value'\n")
    const source: EnvironmentSource = {}
    prepareServerEnvironment({ cwd: root, source })
    expect(source.PASSWORD).toBe("synthetic$literal#value")
  })

  it("keeps one root template covering every planned service", () => {
    const example = readFileSync(resolve(APP_ROOT, "../../.env.example"), "utf8")
    for (const name of ["CLERK_SECRET_KEY", "DATABASE_URL", "OPENROUTER_API_KEY",
      "TRIGGER_SECRET_KEY", "DAYTONA_API_KEY"]) expect(example).toContain(name)
    expect(existsSync(join(APP_ROOT, ".env.example"))).toBe(false)
  })
})

describe("server boundary", () => {
  it("keeps the server configuration module out of the client graph", () => {
    const files = ["app", "components", "hooks"].flatMap((dir) =>
      sourceFiles(resolve(APP_ROOT, dir))
    )
    const clients = files.filter((file) => readFileSync(file, "utf8").includes('"use client"'))

    expect(clients.length).toBeGreaterThan(0)
    for (const file of clients) {
      expect(readFileSync(file, "utf8")).not.toContain("server-env")
    }
  })
})
