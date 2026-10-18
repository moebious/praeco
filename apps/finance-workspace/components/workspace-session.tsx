"use client"

import { UserButton } from "@clerk/nextjs"
import Link from "next/link"
import { Users } from "lucide-react"

export function WorkspaceSession({ authenticated }: { authenticated: boolean }) {
  return (
    <>
      {authenticated ? (
        <div className="flex size-8 shrink-0 items-center justify-center">
          <UserButton />
        </div>
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <Users className="size-4 text-muted-foreground" aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
        <span className="truncate text-sm font-medium">
          {authenticated ? "Sesión autenticada" : "Sesión demo"}
        </span>
        {authenticated ? (
          <span className="text-xs text-muted-foreground">Sin permisos financieros</span>
        ) : (
          <Link href="/sign-in" className="rounded text-xs underline focus-visible:outline-2">
            Configurar acceso
          </Link>
        )}
      </div>
    </>
  )
}
