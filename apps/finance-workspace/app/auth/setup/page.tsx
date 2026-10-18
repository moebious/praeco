import { connection } from "next/server"

import { AuthSetupNotice } from "@/components/auth-setup-notice"
import { getAuthConfiguration } from "@/lib/auth-config"

export const instant = false

export default async function AuthSetupPage() {
  await connection()
  return <AuthSetupNotice configuration={getAuthConfiguration()} />
}
