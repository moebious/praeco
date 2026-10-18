import { createElement } from "react"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { PayableOutcomeBadge } from "@/components/payable-outcome"

const APP_ROOT = resolve(__dirname, "..")

/** Authored surfaces only: vendored registry components are third-party sources. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (relative(APP_ROOT, full) === join("components", "ui")) continue
      sourceFiles(full, out)
      continue
    }
    if (/\.(ts|tsx|mjs|css|svg)$/.test(entry)) out.push(full)
  }
  return out
}

const SOURCE_FILES = ["app", "components", "lib", "actions"].flatMap((dir) =>
  sourceFiles(resolve(APP_ROOT, dir))
)

const FORBIDDEN_WORDING: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "paid", pattern: /\bpaid\b/i },
  { label: "pago/pagó", pattern: /pag[oó]\b/i },
  { label: "pagado", pattern: /pagado/i },
  { label: "payment completed", pattern: /payment\s+completed/i },
]

const GROUND_TRUTH_PATH = [
  { label: "original-manifest", pattern: /original-manifest/i },
  { label: "ground-truth", pattern: /ground[-_]truth/i },
  { label: "expected-outcome", pattern: /expected[-_]outcome/i },
  { label: "index.json", pattern: /index\.json/i },
  // The raw inputs are copied into this app; the runtime must never reach into
  // another package's test fixtures, where the outcome manifests live.
  { label: "foreign fixtures", pattern: /evidence-intelligence[\\/](test|fixtures)/i },
]

describe("financial wording on the payable surface", () => {
  it("scans the authored application sources", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(20)
  })

  it("never claims that money moved", () => {
    for (const file of SOURCE_FILES) {
      const contents = readFileSync(file, "utf8")
      for (const { label, pattern } of FORBIDDEN_WORDING) {
        expect(pattern.test(contents), `${relative(APP_ROOT, file)} matched ${label}`).toBe(false)
      }
    }
  })

  it("uses AUTHORIZED_SIMULATED as the exact literal everywhere", () => {
    let seen = 0
    for (const file of SOURCE_FILES) {
      const contents = readFileSync(file, "utf8")
      for (const match of contents.match(/authorized_simulated/gi) ?? []) {
        expect(match, `${relative(APP_ROOT, file)} used "${match}"`).toBe("AUTHORIZED_SIMULATED")
        seen += 1
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  it("renders the literal, not a paid equivalent, for a simulated authorization", () => {
    const html = renderToStaticMarkup(
      createElement(PayableOutcomeBadge, { outcome: "AUTHORIZED_SIMULATED" })
    )
    expect(html).toContain("AUTHORIZED_SIMULATED")
    for (const { pattern } of FORBIDDEN_WORDING) expect(pattern.test(html)).toBe(false)
  })
})

describe("ground-truth isolation", () => {
  it("references no expected-outcome or manifest path", () => {
    for (const file of SOURCE_FILES) {
      const contents = readFileSync(file, "utf8")
      for (const { label, pattern } of GROUND_TRUTH_PATH) {
        expect(pattern.test(contents), `${relative(APP_ROOT, file)} matched ${label}`).toBe(false)
      }
    }
  })

  it("copies only raw inputs into the app fixture folder", () => {
    const fixtures = readdirSync(join(APP_ROOT, "fixtures", "payable-sources"))
    expect(fixtures.length).toBeGreaterThan(0)
    for (const entry of fixtures) {
      expect(entry, `unexpected outcome file ${entry}`).not.toMatch(
        /index\.json|original-manifest|ground[-_]truth|expected[-_]outcome/i
      )
    }
  })
})
