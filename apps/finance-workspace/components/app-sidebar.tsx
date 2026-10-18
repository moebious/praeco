"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { Search, Wallet } from "lucide-react"

import { cn } from "cn"
import { SpecialistAvatar } from "@/components/specialist-avatar"
import { ThemeToggle } from "@/components/theme-toggle"
import { WorkspaceSession } from "@/components/workspace-session"
import { openSpecialistConversation } from "@/actions/conversations"
import type { ConversationSummary } from "@/lib/conversations"
import { filterConversations } from "@/lib/conversation-search"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { DEMO_CONVERSATIONS, DEMO_TENANT_LABEL, SPECIALISTS } from "@/lib/demo-data"

/** Same mark as app/icon.svg, recolored from theme tokens so it follows light and dark mode. */
function PraecoMark() {
  return (
    <svg viewBox="2 2 28 28" className="size-8 shrink-0 text-foreground" aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor" />
      <path
        d="M11 22V10h5.4a3.8 3.8 0 0 1 0 7.6H11"
        className="stroke-background"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function AppSidebar({
  authenticated = false,
  conversations = DEMO_CONVERSATIONS,
  metadataReady = false,
}: {
  authenticated?: boolean
  conversations?: readonly ConversationSummary[]
  metadataReady?: boolean
}) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const [query, setQuery] = useState("")
  const visibleConversations = filterConversations(conversations, query)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1.5">
          <PraecoMark />
          <div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">Praeco</span>
            <span className="truncate text-xs text-muted-foreground">
              {authenticated ? "Conversaciones privadas" : DEMO_TENANT_LABEL}
            </span>
          </div>
        </div>
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden
          />
          <SidebarInput
            type="search"
            placeholder="Buscar casos"
            aria-label="Buscar casos"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
            }}
            className="pl-8"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Finanzas</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname?.startsWith("/payables") ?? false}
                  tooltip="Cuentas por pagar"
                  render={<Link href="/payables" />}
                  onClick={() => setOpenMobile(false)}
                >
                  <Wallet strokeWidth={1.5} aria-hidden />
                  <span className="truncate text-sm font-medium">Cuentas por pagar</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Equipo</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SPECIALISTS.map((specialist) => (
                <SidebarMenuItem key={specialist.id}>
                  <form action={openSpecialistConversation}>
                    <input type="hidden" name="specialistId" value={specialist.id} />
                    <SidebarMenuButton
                      type="submit"
                      tooltip={specialist.name}
                      disabled={!authenticated || !metadataReady}
                      className="h-auto items-start py-1.5"
                    >
                      <SpecialistAvatar id={specialist.id} size="sm" className="mt-0.5" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{specialist.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{specialist.role}</span>
                      </span>
                    </SidebarMenuButton>
                  </form>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Conversaciones</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleConversations.map((conversation) => {
                const first = conversation.participants[0]
                return (
                  <SidebarMenuItem key={conversation.id}>
                    <SidebarMenuButton
                      isActive={pathname === `/chats/${conversation.id}`}
                      tooltip={conversation.title}
                      className={cn(
                        "h-auto items-start py-2",
                        conversation.unread > 0 && "pr-7"
                      )}
                      render={<Link href={`/chats/${conversation.id}`} />}
                      onClick={() => setOpenMobile(false)}
                    >
                      <SpecialistAvatar id={first} size="sm" className="mt-0.5" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">
                          {conversation.title}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {conversation.preview}
                        </span>
                      </span>
                    </SidebarMenuButton>
                    {conversation.unread > 0 ? (
                      <SidebarMenuBadge className="top-1/2! -translate-y-1/2 rounded-full bg-primary px-1.5 text-primary-foreground!">
                        {conversation.unread}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                )
              })}
              {visibleConversations.length === 0 ? (
                <li role="status" className="px-2 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  {query.trim() ? "No hay conversaciones que coincidan." :
                    metadataReady ? "Elige un especialista para empezar." : "Metadata no disponible."}
                </li>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2 px-1 py-1">
          <WorkspaceSession authenticated={authenticated} />
          <div className="ml-auto group-data-[collapsible=icon]:hidden">
            <ThemeToggle />
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
