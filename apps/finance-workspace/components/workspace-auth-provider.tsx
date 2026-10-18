import { ClerkProvider } from "@clerk/nextjs"
import type { ReactNode } from "react"
import { connection } from "next/server"

import { AuthSetupNotice } from "@/components/auth-setup-notice"
import { getAuthConfiguration } from "@/lib/auth-config"
import { requireServiceConfig } from "@/lib/server-env"

export async function WorkspaceAuthProvider({ children }: { children: ReactNode }) {
  // Read configuration per request, never freeze demo/auth mode into a static build.
  await connection()
  const configuration = getAuthConfiguration()
  if (configuration.mode === "unavailable") {
    return <AuthSetupNotice configuration={configuration} />
  }
  if (configuration.mode === "demo") return children

  const keys = requireServiceConfig("identity")
  return (
    <ClerkProvider
      publishableKey={keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/sign-in"
    >
      {children}
    </ClerkProvider>
  )
}
