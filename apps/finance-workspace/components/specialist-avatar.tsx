import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "cn"
import { getSpecialist, type SpecialistId } from "@/lib/demo-data"

/** Own initials-based avatars: no third-party avatar assets are bundled. */
const ACCENT: Record<SpecialistId, string> = {
  vera: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100",
  kael: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100",
  nova: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
}

export function SpecialistAvatar({
  id,
  size = "default",
  className,
}: {
  id: SpecialistId
  size?: "default" | "sm" | "lg"
  className?: string
}) {
  const specialist = getSpecialist(id)
  return (
    <Avatar size={size} className={className}>
      <AvatarFallback
        aria-label={specialist.name}
        className={cn("text-xs font-semibold", ACCENT[id])}
      >
        {specialist.name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  )
}
