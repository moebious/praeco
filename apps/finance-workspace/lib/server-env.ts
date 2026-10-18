/**
 * Server-side configuration for the blocks after B1.
 *
 * Invariants of this module:
 * - It never reads `process.env` at import time and never opens a connection; it
 *   only answers explicit calls, so B1 keeps booting with no credentials.
 * - Values are never returned, logged, or embedded in error messages. Everything
 *   that can be displayed names variables, never their content.
 * - With no variable defined the result is B1's explicit demo mode.
 * - A configured service is not a connected service: each later block decides
 *   when and how to use it.
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseEnv } from "node:util"

import { z } from "zod"

export type WorkspaceBlock = "B2" | "B3" | "B4" | "B5"

export type ServiceName = "identity" | "database" | "inference" | "sandbox"

/** `set` means defined with a valid shape; it never implies a successful connection. */
export type VariableState = "set" | "missing" | "invalid"

export type ServiceState = "ready" | "partial" | "absent" | "invalid"

export interface VariableStatus {
  readonly name: string
  readonly state: VariableState
}

export interface ServiceStatus {
  readonly service: ServiceName
  readonly block: WorkspaceBlock
  readonly label: string
  readonly state: ServiceState
  readonly variables: readonly VariableStatus[]
}

export interface WorkspaceEnvironmentStatus {
  /** `demo` only while no service has a single defined variable. */
  readonly mode: "demo" | "configured"
  readonly services: readonly ServiceStatus[]
  /** Undefined names, in block order. Never values. */
  readonly missing: readonly string[]
  /** Defined names with an invalid shape. Never values. */
  readonly invalid: readonly string[]
}

/** Variable source, injectable for tests; the real environment by default. */
export type EnvironmentSource = Record<string, string | undefined>

const nonEmpty = z.string().min(1)

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === "postgres:" || protocol === "postgresql:"
  } catch {
    return false
  }
}

const serviceSchemas = {
  identity: z.object({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: nonEmpty,
    CLERK_SECRET_KEY: nonEmpty,
  }),
  database: z.object({
    DATABASE_URL: nonEmpty.refine(isPostgresUrl),
  }),
  inference: z.object({
    OPENROUTER_API_KEY: nonEmpty,
  }),
  sandbox: z.object({
    DAYTONA_API_KEY: nonEmpty,
  }),
} as const

export type ServiceConfiguration<S extends ServiceName> = z.infer<(typeof serviceSchemas)[S]>

const serviceMetadata: Readonly<Record<ServiceName, { block: WorkspaceBlock; label: string }>> = {
  identity: { block: "B2", label: "Identity and session" },
  database: { block: "B3", label: "Conversational metadata persistence" },
  inference: { block: "B4", label: "Model provider inference" },
  sandbox: { block: "B5", label: "Bounded remote sandbox" },
}

const SERVICE_NAMES = Object.keys(serviceSchemas) as ServiceName[]

export const WORKSPACE_ENV_FILE = ".env.local"

function readValue(source: EnvironmentSource, name: string): string | undefined {
  const raw = source[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

function variableStatus(
  source: EnvironmentSource,
  name: string,
  validator: z.ZodType
): VariableStatus {
  const value = readValue(source, name)
  if (value === undefined) return { name, state: "missing" }
  return validator.safeParse(value).success
    ? { name, state: "set" }
    : { name, state: "invalid" }
}

function serviceStatus(service: ServiceName, source: EnvironmentSource): ServiceStatus {
  const shape = serviceSchemas[service].shape as Record<string, z.ZodType>
  const variables = Object.entries(shape).map(([name, validator]) =>
    variableStatus(source, name, validator)
  )
  const hasInvalid = variables.some((variable) => variable.state === "invalid")
  const hasMissing = variables.some((variable) => variable.state === "missing")
  const hasSet = variables.some((variable) => variable.state === "set")
  const state: ServiceState = hasInvalid
    ? "invalid"
    : hasMissing
      ? hasSet
        ? "partial"
        : "absent"
      : "ready"

  return {
    service,
    block: serviceMetadata[service].block,
    label: serviceMetadata[service].label,
    state,
    variables,
  }
}

/**
 * Configuration status per service. Returns names and states, never values, so it
 * is safe for local logs and diagnostic surfaces.
 */
export function describeEnvironment(
  source: EnvironmentSource = process.env
): WorkspaceEnvironmentStatus {
  const services = SERVICE_NAMES.map((service) => serviceStatus(service, source))
  const missing = services.flatMap((service) =>
    service.variables.filter((variable) => variable.state === "missing").map((v) => v.name)
  )
  const invalid = services.flatMap((service) =>
    service.variables.filter((variable) => variable.state === "invalid").map((v) => v.name)
  )
  const mode = services.some((service) => service.state !== "absent") ? "configured" : "demo"

  return { mode, services, missing, invalid }
}

export type ServiceConfigurationResult<S extends ServiceName> =
  | { readonly ok: true; readonly values: ServiceConfiguration<S> }
  | {
      readonly ok: false
      readonly missing: readonly string[]
      readonly invalid: readonly string[]
    }

/**
 * Typed read of one service. It does not throw: it returns the per-variable
 * detail so the owning block can decide how to report and how to fail closed.
 */
export function readServiceConfig<S extends ServiceName>(
  service: S,
  source: EnvironmentSource = process.env
): ServiceConfigurationResult<S> {
  const shape = serviceSchemas[service].shape as Record<string, z.ZodType>
  const names = Object.keys(shape)
  const missing: string[] = []
  const invalid: string[] = []

  for (const name of names) {
    const state = variableStatus(source, name, shape[name]).state
    if (state === "missing") missing.push(name)
    if (state === "invalid") invalid.push(name)
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid }

  const picked: Record<string, string> = {}
  for (const name of names) picked[name] = readValue(source, name) as string
  return { ok: true, values: serviceSchemas[service].parse(picked) as ServiceConfiguration<S> }
}

/**
 * Fails closed with an actionable message that only enumerates missing or
 * malformed names. The received content is never included and the original cause
 * is deliberately not attached, so a log cannot leak a value through it.
 */
export class WorkspaceConfigurationError extends Error {
  readonly service: ServiceName
  readonly missing: readonly string[]
  readonly invalid: readonly string[]

  constructor(
    service: ServiceName,
    detail: { missing: readonly string[]; invalid: readonly string[] }
  ) {
    const parts: string[] = []
    if (detail.missing.length > 0) parts.push(`missing: ${detail.missing.join(", ")}`)
    if (detail.invalid.length > 0) {
      parts.push(`malformed: ${detail.invalid.join(", ")}`)
    }
    super(
      `Configuration for "${service}" is incomplete (${parts.join("; ")}). ` +
        "Check the listed names; variable content is never displayed."
    )
    this.name = "WorkspaceConfigurationError"
    this.service = service
    this.missing = detail.missing
    this.invalid = detail.invalid
  }
}

export function requireServiceConfig<S extends ServiceName>(
  service: S,
  source: EnvironmentSource = process.env
): ServiceConfiguration<S> {
  const result = readServiceConfig(service, source)
  if (!result.ok) throw new WorkspaceConfigurationError(service, result)
  return result.values
}

export interface EnvFileReport {
  /** Path as declared. */
  readonly file: string
  /** Absolute resolved path, useful to diagnose without exposing values. */
  readonly resolved: string
  /** Variables applied to the process environment. */
  readonly applied: readonly string[]
  /** Variables already defined and therefore respected. */
  readonly skipped: readonly string[]
  /** Present only when the file could not be read; never a fatal condition. */
  readonly error?: string
}

export interface EnvironmentLoadReport {
  readonly files: readonly EnvFileReport[]
  readonly applied: readonly string[]
}

const EMPTY_REPORT: EnvironmentLoadReport = { files: [], applied: [] }

let lastLoadReport: EnvironmentLoadReport = EMPTY_REPORT

/** Last load report; empty until `prepareServerEnvironment` runs. */
export function getEnvironmentLoadReport(): EnvironmentLoadReport {
  return lastLoadReport
}

/**
 * Node's dotenv parser supports quotes, multiline values and comments. Values
 * remain literal: `$VAR` is not expanded inside passwords or API keys.
 */
export function parseEnvFile(contents: string): Array<[string, string]> {
  return Object.entries(parseEnv(contents)).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0])
  )
}

export interface LoadWorkspaceEnvOptions {
  /** Locate the Praeco repository from this directory; current directory by default. */
  readonly cwd?: string
  /** Destination for the variables; the process environment by default. */
  readonly source?: EnvironmentSource
}

/** Resolve only this repository's root, never another application's env file. */
function findRepositoryRoot(cwd: string): string | undefined {
  let directory = resolve(cwd)
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
      if (manifest && typeof manifest === "object" && "name" in manifest &&
          manifest.name === "praeco") return directory
    } catch {
      // This ancestor has no readable package manifest; try its parent.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** The only local credential file is `.env.local` at the Praeco repository root. */
export function loadWorkspaceEnvFile(
  options: LoadWorkspaceEnvOptions = {}
): EnvironmentLoadReport {
  const root = findRepositoryRoot(options.cwd ?? process.cwd())
  if (!root) return { files: [], applied: [] }

  const resolved = join(root, WORKSPACE_ENV_FILE)
  const target = options.source ?? process.env
  let contents: string
  try {
    contents = readFileSync(resolved, "utf8")
  } catch {
    return {
      files: [{ file: WORKSPACE_ENV_FILE, resolved, applied: [], skipped: [], error: "unreadable" }],
      applied: [],
    }
  }

  const applied: string[] = []
  const skipped: string[] = []
  for (const [name, value] of parseEnvFile(contents)) {
    if (target[name] !== undefined) {
      skipped.push(name)
      continue
    }
    target[name] = value
    applied.push(name)
  }
  return {
    files: [{ file: WORKSPACE_ENV_FILE, resolved, applied, skipped }],
    applied,
  }
}

/**
 * Loaded by Next config (before public-variable bundling), Node instrumentation
 * and Proxy. Existing process variables always win, including explicit empty
 * values. Reading configuration never connects a service.
 */
export function prepareServerEnvironment(
  options: LoadWorkspaceEnvOptions = {}
): EnvironmentLoadReport {
  lastLoadReport = loadWorkspaceEnvFile(options)
  return lastLoadReport
}
