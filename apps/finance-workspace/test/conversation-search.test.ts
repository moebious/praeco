import { describe, expect, it } from "vitest"

import { filterConversations } from "@/lib/conversation-search"
import { DEMO_CONVERSATIONS } from "@/lib/demo-data"

describe("authorized conversation search", () => {
  it("matches a partial case identifier without changing order", () => {
    expect(filterConversations(DEMO_CONVERSATIONS, "013").map((row) => row.id))
      .toEqual(["caso-0139", "caso-0131"])
  })

  it("matches titles without case, accent or surrounding-space sensitivity", () => {
    expect(filterConversations(DEMO_CONVERSATIONS, "  REVISION DE PROVEEDOR  ").map((row) => row.id))
      .toEqual(["caso-0131"])
  })

  it("searches the preview as well as the title", () => {
    expect(filterConversations(DEMO_CONVERSATIONS, "presupuesto").map((row) => row.id))
      .toEqual(["caso-0131"])
  })

  it("returns no matches for an unknown term and restores the list when cleared", () => {
    expect(filterConversations(DEMO_CONVERSATIONS, "zz-no-existe-947")).toEqual([])
    expect(filterConversations(DEMO_CONVERSATIONS, "   ")).toEqual(DEMO_CONVERSATIONS)
  })

  it("never widens the caller's authorized list", () => {
    const scoped = DEMO_CONVERSATIONS.filter((row) => row.id === "caso-0142")
    expect(filterConversations(scoped, "0131")).toEqual([])
    expect(filterConversations([], "")).toEqual([])
  })
})
