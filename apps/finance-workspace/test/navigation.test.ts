import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const request = vi.hoisted(() => ({ cookie: undefined as string | undefined }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({ requireWorkspacePageAccess: vi.fn(async () => false) }))
vi.mock("@/lib/conversation-service", async () => {
  const { DEMO_CONVERSATIONS } = await import("@/lib/demo-data")
  return {
    getWorkspaceConversations: async () => ({ mode: "demo", conversations: DEMO_CONVERSATIONS }),
  }
})
vi.mock("@/actions/conversations", () => ({ openSpecialistConversation: vi.fn() }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "sidebar_state" && request.cookie !== undefined
      ? { name, value: request.cookie }
      : undefined,
  }),
}))
vi.mock("@/components/app-sidebar", async () => {
  const { createElement } = await import("react")
  const { Sidebar } = await import("@/components/ui/sidebar")
  return { AppSidebar: () => createElement(Sidebar) }
})

import WorkspaceLayout from "@/app/(workspace)/layout"
import WorkspaceHome from "@/app/(workspace)/page"
import { SidebarProvider } from "@/components/ui/sidebar"

beforeEach(() => { request.cookie = undefined })

describe("workspace navigation across requests", () => {
  it.each([
    ["false", false],
    ["true", true],
    [undefined, true],
    ["unrecognized", true],
  ] as const)("restores sidebar preference %s on the next request", async (cookie, expected) => {
    request.cookie = cookie
    const layout = await WorkspaceLayout({ children: "Synthetic page" })
    const html = renderToStaticMarkup(layout)
    expect(html).toContain(`data-state="${expected ? "expanded" : "collapsed"}"`)
  })

  it("renders a navigation button on home, where mobile has no visible sidebar", async () => {
    const home = await WorkspaceHome({ searchParams: Promise.resolve({}) })
    const html = renderToStaticMarkup(createElement(SidebarProvider, null, home))
    expect(html).toContain('data-slot="sidebar-trigger"')
    expect(html).toContain('aria-label="Alternar navegación"')
  })
})
