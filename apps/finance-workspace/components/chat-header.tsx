import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { SpecialistAvatar } from "@/components/specialist-avatar"
import { DesktopStatus } from "@/components/desktop-status"
import { AvatarGroup } from "@/components/ui/avatar"
import { SPECIALISTS } from "@/lib/demo-data"
import type { ConversationSummary } from "@/lib/conversations"

export function ChatHeader({ conversation }: { conversation: ConversationSummary }) {
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1" />
      <AvatarGroup className="shrink-0">
        {conversation.participants.map((id) => (
          <SpecialistAvatar key={id} id={id} size="sm" />
        ))}
      </AvatarGroup>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{conversation.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {conversation.participants
            .map((id) => SPECIALISTS.find((s) => s.id === id)?.name ?? id)
            .join(" · ")}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <DesktopStatus />
      </div>
    </header>
  )
}
