import "server-only"

import { prepareServerEnvironment, type EnvironmentSource } from "@/lib/server-env"

const identityVariables = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
] as const

export interface AuthConfiguration {
  readonly mode: "demo" | "clerk" | "unavailable"
  readonly missing: readonly string[]
  readonly invalid: readonly string[]
}

/** Shape validation only, not a claim that the credentials work with Clerk. */
export function resolveAuthConfiguration(source: EnvironmentSource): AuthConfiguration {
  const values = identityVariables.map((name) => source[name]?.trim() ?? "")
  if (values.every((value) => value === "")) {
    return { mode: "demo", missing: [...identityVariables], invalid: [] }
  }

  const missing = identityVariables.filter((_, index) => values[index] === "")
  const prefixes = ["pk_test_", "sk_test_"]
  const invalid = identityVariables.filter((_, index) => {
    const value = values[index]
    return value !== "" && (!value.startsWith(prefixes[index]) || /\s/.test(value) ||
      value.length <= prefixes[index].length)
  })

  return {
    mode: missing.length || invalid.length ? "unavailable" : "clerk",
    missing,
    invalid,
  }
}

/** Proxy and rendering may run separately, so both load the same root file. */
export function getAuthConfiguration(): AuthConfiguration {
  prepareServerEnvironment()
  return resolveAuthConfiguration(process.env)
}

export function isPublicAuthRoute(pathname: string): boolean {
  return pathname === "/api/health" || pathname === "/auth/setup" ||
    pathname === "/sign-in" || pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" || pathname.startsWith("/sign-up/")
}
