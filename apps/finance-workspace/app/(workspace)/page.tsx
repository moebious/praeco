import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Info } from "lucide-react"

import { SpecialistAvatar } from "@/components/specialist-avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SPECIALISTS } from "@/lib/demo-data"
import { requireWorkspacePageAccess } from "@/lib/auth"
import { getWorkspaceConversations } from "@/lib/conversation-service"
import { openSpecialistConversation } from "@/actions/conversations"
import { WorkspaceMetadataNotice } from "@/components/workspace-metadata-notice"
import type { MetadataErrorCode } from "@/lib/conversations"

export const metadata: Metadata = { title: "Equipo" }

export default async function WorkspaceHome({
  searchParams,
}: {
  searchParams: Promise<{ workspaceError?: string }>
}) {
  await requireWorkspacePageAccess()
  const [workspace, query] = await Promise.all([getWorkspaceConversations(), searchParams])
  const actionErrors: readonly MetadataErrorCode[] = [
    "DATABASE_NOT_CONFIGURED", "DATABASE_SCHEMA_MISSING", "DATABASE_UNAVAILABLE",
    "CONVERSATION_NOT_FOUND", "INVALID_CONVERSATION_INPUT",
  ]
  const actionError = actionErrors.find((code) => code === query.workspaceError)
  const { conversations } = workspace
  return (
    <>
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <SidebarTrigger aria-label="Alternar navegación" />
      <span className="text-sm font-medium">Praeco</span>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Equipo de cuentas por pagar</h1>
            <Badge variant="outline">
              modo demo
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Tres perfiles disponibles desde el primer acceso. Un perfil visible no concede
            autoridad: la decisión financiera vive en el kernel, no en la conversación.
          </p>
        </div>

        {workspace.mode === "unavailable" ? (
          <WorkspaceMetadataNotice code={workspace.code} />
        ) : actionError ? (
          <WorkspaceMetadataNotice code={actionError} />
        ) : null}

        <p className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground shadow-border">
          <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          <span>
            {workspace.mode === "persisted"
              ? "La identidad y los títulos de tus conversaciones se guardan en PostgreSQL. Los mensajes siguen siendo programados y no se guardan; todavía no hay proveedor de modelo ni evaluación financiera."
              : "Este bloque entrega la interfaz local. Todavía no hay proveedor de modelo ni evaluación financiera: las conversaciones usan contenido programado."}
          </span>
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          {SPECIALISTS.map((specialist) => (
            <Card key={specialist.id}>
              <CardHeader className="gap-2">
                <SpecialistAvatar id={specialist.id} size="lg" />
                <CardTitle className="text-sm">{specialist.name}</CardTitle>
                <CardDescription className="text-xs">{specialist.role}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{specialist.note}</p>
                {workspace.mode === "persisted" ? (
                  <form action={openSpecialistConversation} className="mt-3">
                    <input type="hidden" name="specialistId" value={specialist.id} />
                    <Button type="submit" size="sm">Abrir conversación</Button>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Conversaciones</h2>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  href={`/chats/${conversation.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <SpecialistAvatar id={conversation.participants[0]} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{conversation.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {conversation.preview}
                    </span>
                  </span>
                  <span className="ml-auto flex items-center gap-3">
                    {conversation.unread > 0 ? (
                      <Badge className="min-w-5 rounded-full px-1.5 tabular-nums">{conversation.unread}</Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">{conversation.activity}</span>
                    <ArrowRight
                      className="size-3.5 text-muted-foreground"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  </span>
                </Link>
              </li>
            ))}
            {workspace.mode === "persisted" && conversations.length === 0 ? (
              <li className="px-4 py-3 text-sm text-muted-foreground">
                Elige un especialista. Se prepararán tres conversaciones privadas sin duplicarlas.
              </li>
            ) : null}
          </ul>
        </div>

      </div>
    </div>
    </>
  )
}
