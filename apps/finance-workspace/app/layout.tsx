import type { Metadata } from "next"
import { Suspense } from "react"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"

import { ThemeProvider } from "@/components/theme-provider"
import { WorkspaceAuthProvider } from "@/components/workspace-auth-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./globals.css"

export const metadata: Metadata = {
  applicationName: "Praeco",
  title: {
    default: "Praeco — Cuentas por pagar",
    template: "%s · Praeco",
  },
  description:
    "Equipo de agentes de cuentas por pagar con evidencia verificable, autorización determinística y aprobación humana. Datos sintéticos.",
}

export const instant = false

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>
            <Suspense fallback={<p className="p-6 text-sm" role="status">Cargando Praeco…</p>}>
              <WorkspaceAuthProvider>{children}</WorkspaceAuthProvider>
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
