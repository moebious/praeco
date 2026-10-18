import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { workspaceChatTools } from "@/lib/chat/tools"

describe("chat tool boundary", () => {
  it("exposes only the synthetic, read-only workspace inspection capability", () => {
    expect(Object.keys(workspaceChatTools)).toEqual(["inspect_workspace"])
    expect(workspaceChatTools.inspect_workspace.execute).toBeTypeOf("function")
  })

  it("does not tell the model that financial capabilities are connected", () => {
    const agent = readFileSync(resolve(__dirname, "../trigger/chat.ts"), "utf8")
    expect(agent).toContain("No tienes herramientas financieras")
    expect(agent).not.toMatch(/list_payable_cases|inspect_payable_case|evaluate_payable_policy|authorize_payable|resolve_payable_approval/)
    expect(agent).not.toMatch(/role:\s*"system"/)
  })
})
