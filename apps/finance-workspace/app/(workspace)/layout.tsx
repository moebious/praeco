import type * as React from "react"
import { cookies } from "next/headers"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { requireWorkspacePageAccess } from "@/lib/auth"
import { getWorkspaceConversations } from "@/lib/conversation-service"

/**
 * The workspace shell is dynamic by nature: the sidebar highlights the active
 * route with `usePathname()` and there is no static prerender value to gain.
 * Documented opt-out of Cache Components validation (Next 16).
 */
export const instant = false

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const authenticated = await requireWorkspacePageAccess()
  const [workspace, cookieStore] = await Promise.all([getWorkspaceConversations(), cookies()])
  return (
    <SidebarProvider defaultOpen={cookieStore.get("sidebar_state")?.value !== "false"}>
      <AppSidebar
        authenticated={authenticated}
        conversations={workspace.conversations}
        metadataReady={workspace.mode === "persisted"}
      />
      <SidebarInset className="flex h-svh min-h-0 flex-col">{children}</SidebarInset>
    </SidebarProvider>
  )
}
