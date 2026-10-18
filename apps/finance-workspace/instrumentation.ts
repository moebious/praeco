/**
 * Server startup. Next calls `register` once per server instance and also in
 * demo mode, so nothing connects a provider here and no key is checked against
 * its service: it only loads the repository-root `.env.local`. Without that
 * file the demo boot is unchanged.
 *
 * Node-only code is imported inside `register` so it never reaches the Edge
 * runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { prepareServerEnvironment } = await import("./lib/server-env")
  prepareServerEnvironment()
}
