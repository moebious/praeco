"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react"
import { Chat } from "@/components/chat"
import { Button } from "@/components/ui/button"
import { bootstrapChat, loadChatTranscript, mintChatAccessToken, startChatSession } from "@/actions/chat"
import { CHAT_TASK_ID, type WorkspaceChatMessage } from "@/lib/chat/contracts"
import { chatErrorMessage, presentChatMessages } from "@/lib/chat/presentation"
import type { SpecialistId } from "@/lib/demo-data"
import type { workspaceChat } from "@/trigger/chat"

type Bootstrap = Awaited<ReturnType<typeof bootstrapChat>>

export function LiveChat({ chatId, specialistId }: { chatId: string; specialistId: SpecialistId }) {
  const [initial, setInitial] = useState<Bootstrap>()
  const [failure, setFailure] = useState<unknown>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    bootstrapChat({ chatId }).then((data) => {
      if (current) { setInitial(data); setFailure(undefined) }
    }).catch((error: unknown) => { if (current) setFailure(error) })
    return () => { current = false }
  }, [chatId, attempt])

  if (failure) return (
    <section role="alert" className="m-4 space-y-3 rounded-lg bg-muted/40 p-4 text-sm">
      <p>{chatErrorMessage(failure)}</p>
      <Button variant="outline" onClick={() => { setFailure(undefined); setAttempt((value) => value + 1) }}>
        Reintentar carga del historial
      </Button>
    </section>
  )
  if (!initial) return <p role="status" className="p-4 text-sm">Cargando historial autorizado…</p>
  return <LiveChatSession key={chatId} chatId={chatId} specialistId={specialistId} initial={initial} />
}

function LiveChatSession({ chatId, specialistId, initial }: {
  chatId: string; specialistId: SpecialistId; initial: Bootstrap
}) {
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [stopped, setStopped] = useState(false)
  const [nextCursor, setNextCursor] = useState(initial.nextCursor)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const sending = useRef(false)
  const transport = useTriggerChatTransport<typeof workspaceChat>({
    task: CHAT_TASK_ID,
    accessToken: ({ chatId: id }) => mintChatAccessToken({ chatId: id }),
    startSession: ({ chatId: id }) => startChatSession({ chatId: id }),
    clientData: {},
    sessions: initial.session ? { [chatId]: initial.session } : undefined,
  })
  const chat = useChat<WorkspaceChatMessage>({
    id: chatId, transport, messages: initial.messages, resume: Boolean(initial.session),
    onError: (error) => setFailure(error),
  })
  const visible = useMemo(() => presentChatMessages(chat.messages, specialistId), [chat.messages, specialistId])
  const initialVisible = useMemo(() => presentChatMessages(initial.messages, specialistId), [initial.messages, specialistId])
  const streaming = busy || chat.status === "submitted" || chat.status === "streaming"
  const error = failure ?? chat.error

  async function send() {
    const text = draft.trim()
    if (!text || text.length > 1200 || streaming || sending.current) return
    sending.current = true
    setBusy(true)
    setFailure(undefined)
    setStopped(false)
    setDraft("")
    try {
      await chat.sendMessage({ text })
    } catch (reason) {
      setFailure(reason)
      setDraft(text)
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  async function stop() {
    setStopped(true)
    const localStop = chat.stop()
    try { await Promise.all([localStop, transport.stopGeneration(chatId)]) }
    catch (reason) { setFailure(reason) }
  }

  async function loadOlder() {
    if (!nextCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const older = await loadChatTranscript({ chatId, before: nextCursor })
      chat.setMessages((current) => {
        const seen = new Set(older.messages.map((message) => message.id))
        return [...older.messages, ...current.filter((message) => !seen.has(message.id))]
      })
      setNextCursor("nextCursor" in older ? older.nextCursor : undefined)
    } catch (reason) { setFailure(reason) }
    finally { setLoadingOlder(false) }
  }

  return (
    <>
      {nextCursor ? (
        <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={loadOlder}>
          {loadingOlder ? "Cargando…" : "Cargar mensajes anteriores"}
        </Button>
      ) : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm">
          <p>{chatErrorMessage(error)}</p>
          <Button variant="outline" size="sm" disabled={streaming} onClick={() => {
            setFailure(undefined)
            void chat.regenerate().catch((reason: unknown) => setFailure(reason))
          }}>Reintentar explícitamente</Button>
        </div>
      ) : stopped ? (
        <p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
          Generación detenida. Una llamada abortada puede tener coste; no se reintentará automáticamente.
        </p>
      ) : null}
      <Chat thread={initialVisible} specialistId={specialistId}
        notice="Chat con OpenRouter mediante Trigger. Historial en Trigger; metadata en Neon. Solo datos sintéticos y una herramienta de lectura. Sin herramientas ni autoridad financiera."
        controller={{ messages: visible, draft, streaming, onDraftChange: setDraft,
          send: () => { void send() }, stop: () => { void stop() } }} />
    </>
  )
}
