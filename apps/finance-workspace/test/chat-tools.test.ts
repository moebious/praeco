import { describe, expect, it } from "vitest"
import { workspaceChatTools } from "@/lib/chat/tools"

describe("chat tool boundary", () => {
  it("exposes only the synthetic, read-only workspace inspection capability", () => {
    expect(Object.keys(workspaceChatTools)).toEqual(["inspect_workspace"])
    expect(workspaceChatTools.inspect_workspace.execute).toBeTypeOf("function")
  })
})
