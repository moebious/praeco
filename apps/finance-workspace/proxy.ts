import { clerkMiddleware } from "@clerk/nextjs/server"
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server"

import { getAuthConfiguration, isPublicAuthRoute } from "@/lib/auth-config"
import { requireServiceConfig } from "@/lib/server-env"

const authenticatedProxy = clerkMiddleware(async (auth, request) => {
  if (isPublicAuthRoute(request.nextUrl.pathname)) return NextResponse.next()

  const session = await auth()
  if (!session.userId) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "AUTHENTICATION_REQUIRED" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      )
    }
    return session.redirectToSignIn({ returnBackUrl: request.url })
  }
  return NextResponse.next()
}, () => {
  const keys = requireServiceConfig("identity")
  return {
    publishableKey: keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    // A single Clerk instance reads CLERK_SECRET_KEY from the server environment.
    // Passing it as a dynamic key would require another encryption credential.
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
    debug: false,
  }
})

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const configuration = getAuthConfiguration()
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next()
  if (configuration.mode === "demo") return NextResponse.next()
  if (configuration.mode === "unavailable") {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "AUTHENTICATION_UNAVAILABLE" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      )
    }
    // A streamed rewrite can replace Proxy's status with 200. Return the failure
    // directly so neither the workspace nor a success status can slip through.
    return new NextResponse(`<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configurar acceso · Praeco</title>
<style>
:root{color-scheme:light dark}body{margin:0;font:16px/1.6 system-ui;background:Canvas;color:CanvasText}
main{max-width:36rem;margin:12vh auto;padding:1.5rem}h1{font-size:1.5rem}
code{overflow-wrap:anywhere}a{color:inherit}a:focus-visible{outline:2px solid currentColor}
</style></head><body><main>
<h1>Acceso a Praeco</h1>
<p>La autenticación está incompleta. El acceso queda bloqueado hasta corregir la configuración.</p>
<p>Configura ambas claves Development de Clerk en <code>.env.local</code> de la raíz del repositorio
y reinicia el servidor. No compartas los valores en el chat.</p>
<p>Variables que debes revisar: <code>${[...configuration.missing, ...configuration.invalid].join(", ")}</code>.</p>
</main></body></html>`, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    })
  }
  return authenticatedProxy(request, event)
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|map|txt)).*)",
    "/api/(.*)",
  ],
}
