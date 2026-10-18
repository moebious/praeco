import Link from "next/link"

import type { MetadataErrorCode } from "@/lib/conversations"

const explanations: Record<MetadataErrorCode, string> = {
  DATABASE_NOT_CONFIGURED: "Configura DATABASE_URL en el archivo .env.local de la raíz y reinicia el servidor.",
  DATABASE_SCHEMA_MISSING: "Falta la migración del schema praeco_workspace. No se crean tablas desde la aplicación.",
  DATABASE_UNAVAILABLE: "No se pudo leer PostgreSQL. Revisa la conexión y los permisos; no se sustituye por un historial falso.",
  CONVERSATION_NOT_FOUND: "La conversación no existe o no tienes acceso.",
  INVALID_CONVERSATION_INPUT: "Revisa el especialista o el título de la conversación.",
}

export function WorkspaceMetadataNotice({ code }: { code: MetadataErrorCode }) {
  return (
    <section role="alert" className="m-4 space-y-2 rounded-lg bg-muted/40 p-4 text-sm shadow-border">
      <h2 className="font-medium">No se pudo abrir la metadata conversacional</h2>
      <p>{explanations[code]}</p>
      <Link href="/" prefetch={false} className="inline-block rounded underline focus-visible:outline-2">
        Volver a intentar
      </Link>
    </section>
  )
}
