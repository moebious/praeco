import Link from "next/link"

import type { AuthConfiguration } from "@/lib/auth-config"

export function AuthSetupNotice({ configuration }: { configuration: AuthConfiguration }) {
  const demo = configuration.mode === "demo"
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section className="w-full max-w-lg space-y-4 rounded-xl border p-6">
        <h1 className="text-xl font-semibold">Acceso a Praeco</h1>
        <p className="text-sm text-muted-foreground">
          {demo
            ? "Modo demo sin autenticación. Solo hay conversaciones sintéticas programadas."
            : "La autenticación está incompleta. El acceso queda bloqueado hasta corregir la configuración."}
        </p>
        <p className="text-sm">
          Configura las claves Development de Clerk en el archivo local ignorado
          {" "}<code>.env.local</code> de la raíz del repositorio y reinicia el servidor.
          No compartas los valores en el chat.
        </p>
        {configuration.missing.length > 0 ? (
          <p className="text-sm">Faltan: <code>{configuration.missing.join(", ")}</code></p>
        ) : null}
        {configuration.invalid.length > 0 ? (
          <p className="text-sm">
            Revisa el formato (solo claves Development):{" "}
            <code>{configuration.invalid.join(", ")}</code>
          </p>
        ) : null}
        {demo ? (
          <Link href="/" className="inline-block rounded underline focus-visible:outline-2">
            Volver a la demo
          </Link>
        ) : null}
      </section>
    </main>
  )
}
