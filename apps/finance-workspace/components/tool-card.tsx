import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Loader2,
  RotateCcw,
  type LucideIcon,
} from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import type { ToolPart, ToolStatus } from "@/lib/demo-data"

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "En ejecución",
  completed: "Completado",
  review: "Requiere revisión",
  error: "Error",
}

const STATUS_CLASS: Record<ToolStatus, string> = {
  running: "text-muted-foreground",
  completed: "text-success",
  review: "text-warning",
  error: "text-destructive",
}

const STATUS_ICONS: readonly { status: ToolStatus; Icon: LucideIcon; spin?: boolean }[] = [
  { status: "running", Icon: Loader2, spin: true },
  { status: "completed", Icon: CheckCircle2 },
  { status: "review", Icon: AlertTriangle },
  { status: "error", Icon: CircleX },
]

/** Every status icon stays mounted so a status change cross-fades instead of snapping. */
function StatusIcon({ status }: { status: ToolStatus }) {
  return (
    <span className="relative size-3.5">
      {STATUS_ICONS.map(({ status: iconStatus, Icon, spin }) => (
        <Icon
          key={iconStatus}
          strokeWidth={1.5}
          aria-hidden
          className={cn(
            "absolute inset-0 size-3.5 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
            spin && "animate-spin",
            iconStatus === status
              ? "scale-100 opacity-100 blur-[0px]"
              : "scale-[0.25] opacity-0 blur-[4px]"
          )}
        />
      ))}
    </span>
  )
}

export function ToolCard({
  part,
  onRetry,
}: {
  part: ToolPart
  onRetry?: () => void
}) {
  return (
    <div
      role="status"
      aria-label={`Herramienta ${part.name}: ${STATUS_LABEL[part.status]}`}
      className="rounded-lg bg-card/60 p-3 text-sm shadow-border"
    >
      <div className="flex items-center gap-2">
        <span className={cn("flex items-center", STATUS_CLASS[part.status])}>
          <StatusIcon status={part.status} />
        </span>
        <code className="font-mono text-xs text-foreground">{part.name}</code>
        <span className={cn("ml-auto text-xs font-medium", STATUS_CLASS[part.status])}>
          {STATUS_LABEL[part.status]}
        </span>
      </div>
      <p className="mt-1.5 text-foreground">{part.summary}</p>
      {part.detail ? (
        <p className="mt-1 text-xs text-muted-foreground">{part.detail}</p>
      ) : null}
      {part.retryable && onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={onRetry}
        >
          <RotateCcw aria-hidden />
          Reintentar
        </Button>
      ) : null}
    </div>
  )
}
