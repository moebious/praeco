import { SignIn } from "@clerk/nextjs"
import { connection } from "next/server"

import { AuthSetupNotice } from "@/components/auth-setup-notice"
import { getAuthConfiguration } from "@/lib/auth-config"

export const instant = false

export default async function SignInPage() {
  await connection()
  const configuration = getAuthConfiguration()
  if (configuration.mode !== "clerk") return <AuthSetupNotice configuration={configuration} />
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </main>
  )
}
