import { NextResponse } from "next/server"

/** Sane liveness probe: no configuration, credentials or tenant data. */
export function GET() {
  return NextResponse.json({
    status: "ok",
    app: "praeco-finance-workspace",
    mode: "demo",
  })
}
