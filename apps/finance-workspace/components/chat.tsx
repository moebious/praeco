"use client"

import * as React from "react"
import { ArrowUp, Info, Square } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SpecialistAvatar } from "@/components/specialist-avatar"
import { ToolCard } from "@/components/tool-card"
import {
  DEMO_NOTICE,
  getSpecialist,
  type DemoMessage,
  type MessagePart,
  type SpecialistId,
} from "@/lib/demo-data"

function timeLabel() {
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    // Seeded transcript times are 24-hour ("09:14"); es-CO would otherwise append "a. m.".
    hourCycle: "h23",
  }).format(new Date())
}

const SWAP_TRANSITION =
  "transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)]"
const SWAP_SHOWN = "scale-100 opacity-100 blur-[0px]"
const SWAP_HIDDEN = "pointer-events-none scale-[0.25] opacity-0 blur-[4px]"

function PartView({
  part,
  onRetry,
}: {
  part: MessagePart
  onRetry?: () => void
}) {
  if (part.kind === "tool") {
    return <ToolCard part={part} onRetry={onRetry} />
  }
  return <p className="text-sm leading-relaxed whitespace-pre-wrap">{part.text}</p>
}

export interface ChatController {
  messages: readonly DemoMessage[]
  draft: string
  streaming: boolean
  onDraftChange: (value: string) => void
  send: () => void
  stop: () => void
}

export function Chat({
  thread,
  specialistId = "vera",
  notice = DEMO_NOTICE,
  controller,
}: {
  thread: readonly DemoMessage[]
  specialistId?: SpecialistId
  notice?: string
  controller?: ChatController
}) {
  const [demoMessages, setMessages] = React.useState<DemoMessage[]>(() => [...thread])
  const [demoDraft, setDraft] = React.useState("")
  const [demoStreaming, setStreaming] = React.useState(false)
  const messages = controller?.messages ?? demoMessages
  const draft = controller?.draft ?? demoDraft
  const streaming = controller?.streaming ?? demoStreaming
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null)
  const timers = React.useRef<ReturnType<typeof setTimeout>[]>([])
  // Messages present on open render statically; only later arrivals animate in.
  const [initialIds] = React.useState(() => new Set(thread.map((message) => message.id)))

  const hasScrolled = React.useRef(false)

  React.useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    // Land on the latest message instantly on open; glide only for messages added afterwards.
    element.scrollTo({
      top: element.scrollHeight,
      behavior: hasScrolled.current ? "smooth" : "instant",
    })
    hasScrolled.current = true
  }, [messages])

  React.useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])

  function stopTimers() {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  /** Programmed two-step run used by both a new send and an explicit retry. */
  const runProgrammedReply = React.useCallback((replyId: string) => {
    stopTimers()
    setStreaming(true)
    setMessages((prev) =>
      prev.map((message) =>
        message.id === replyId
          ? {
              ...message,
              parts: [
                {
                  kind: "tool",
                  id: `${replyId}-tool`,
                  name: "mostrar_demo",
                  summary: "Preparando respuesta programada…",
                  status: "running",
                },
              ],
            }
          : message
      )
    )

    timers.current.push(
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyId
              ? {
                  ...message,
                  parts: [
                    {
                      kind: "tool",
                      id: `${replyId}-tool`,
                      name: "mostrar_demo",
                      summary: "Respuesta programada preparada",
                      status: "completed",
                      detail:
                        "Modo demo: no se procesó ninguna fuente real ni se consultó a un proveedor.",
                    },
                  ],
                }
              : message
          )
        )
      }, 900)
    )

    timers.current.push(
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyId
              ? {
                  ...message,
                  parts: [
                    ...message.parts,
                    {
                      kind: "text",
                      text: "Recibido. En modo demo no hay proveedor conectado: esta respuesta es programada y no ejecuta procesamiento real.",
                    },
                  ],
                }
              : message
          )
        )
      }, 1500)
    )

    timers.current.push(setTimeout(() => setStreaming(false), 1700))
  }, [])

  function send() {
    if (controller) { controller.send(); return }
    const text = draft.trim()
    // A second send is impossible while a run is in flight, and the composer is
    // empty unless a send was accepted, so a stray click can never resend text.
    if (!text || streaming) return

    const stamp = Date.now()
    const replyId = `reply-${stamp}`
    setDraft("")
    // The send button turns inert while the reply runs; keep focus in the composer.
    composerRef.current?.focus()
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${stamp}`,
        author: "user",
        at: timeLabel(),
        parts: [{ kind: "text", text }],
      },
      {
        id: replyId,
        author: specialistId,
        at: timeLabel(),
        parts: [],
      },
    ])
    runProgrammedReply(replyId)
  }

  function stop() {
    if (controller) { controller.stop(); return }
    stopTimers()
    setStreaming(false)
    composerRef.current?.focus()
    // Nothing is reported as done. The draft is intentionally NOT put back into
    // the composer: the message is already in the transcript, and a click whose
    // mouseup lands on the send button must never resend it. Recovery is the
    // explicit retry below.
    setMessages((prev) =>
      prev.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.kind === "tool" && part.status === "running"
            ? {
                ...part,
                status: "error" as const,
                summary: "Detenido por el usuario",
                detail:
                  "La ejecución simulada se canceló antes de terminar. Puedes reintentarla.",
                retryable: true,
              }
            : part
        ),
      }))
    )
  }

  function retry(messageId: string) {
    if (streaming) return
    runProgrammedReply(messageId)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Kept outside the scroll area: the demo declaration must always be visible. */}
      <p className="mx-auto flex w-full max-w-3xl shrink-0 items-start gap-2 px-4 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
        <span>{notice}</span>
      </p>

      {/* Fade the top edge so scrolled messages slide under the notice instead of being cut off against it. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_24px)]"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-4 pb-6">
          {messages.map((message, index) => {
            const enter = initialIds.has(message.id) ? undefined : "motion-safe:animate-message-enter"
            if (message.author === "user") {
              return (
                <div key={message.id} className={cn("flex justify-end", enter)}>
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-muted px-3.5 py-2 text-foreground">
                    {message.parts.map((part) => (
                      <PartView
                        key={part.kind === "tool" ? part.id : part.text}
                        part={part}
                      />
                    ))}
                  </div>
                </div>
              )
            }

            const specialist = getSpecialist(message.author)
            // Consecutive turns from one specialist read as a single block.
            const continuation = messages[index - 1]?.author === message.author
            return (
              <div key={message.id} className={cn("flex gap-3", continuation && "-mt-4", enter)}>
                {continuation ? (
                  <span className="w-6 shrink-0" aria-hidden />
                ) : (
                  <SpecialistAvatar id={specialist.id} size="sm" className="mt-0.5" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {continuation ? null : (
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{specialist.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {specialist.role}
                      </span>
                      {message.at ? (
                        <span className="text-xs text-muted-foreground">{message.at}</span>
                      ) : null}
                    </div>
                  )}
                  {message.parts.map((part) => (
                    <PartView
                      key={part.kind === "tool" ? part.id : part.text}
                      part={part}
                      onRetry={() => retry(message.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <form
        className="shrink-0 border-t border-border bg-background"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="mx-auto max-w-3xl px-4 py-3">
          {/* 16px = 8px button radius + 8px inset from the corner (right-2 bottom-2). */}
          <div className="relative rounded-[16px] bg-card shadow-border transition-[box-shadow] duration-150 ease-out focus-within:shadow-border-hover">
            <Textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => controller ? controller.onDraftChange(event.target.value) : setDraft(event.target.value)}
              maxLength={controller ? 1200 : undefined}
              onKeyDown={onKeyDown}
              placeholder="Escribe al equipo…"
              aria-label="Mensaje para el equipo"
              rows={1}
              className="min-h-11 resize-none border-0 bg-transparent pr-12 shadow-none focus-visible:ring-0"
            />
            {/* Both buttons stay mounted in one fixed slot and cross-fade, so the composer never reflows. */}
            <div className="absolute right-2 bottom-2 size-7">
              <span
                inert={streaming}
                className={cn("absolute inset-0", SWAP_TRANSITION, streaming ? SWAP_HIDDEN : SWAP_SHOWN)}
              >
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={!draft.trim()}
                  aria-label="Enviar mensaje"
                >
                  <ArrowUp aria-hidden />
                </Button>
              </span>
              <span
                inert={!streaming}
                className={cn("absolute inset-0", SWAP_TRANSITION, streaming ? SWAP_SHOWN : SWAP_HIDDEN)}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon-sm"
                        aria-label="Detener"
                        onClick={stop}
                      />
                    }
                  >
                    <Square className="fill-current" aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent>Detener</TooltipContent>
                </Tooltip>
              </span>
            </div>
          </div>
          <p className="mt-1.5 hidden text-xs text-muted-foreground sm:block">
            Enter envía · Shift+Enter salto de línea
          </p>
        </div>
      </form>
    </div>
  )
}
