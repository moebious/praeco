import { defineConfig } from "@trigger.dev/sdk"

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_unconfigured",
  dirs: ["./trigger"],
  runtime: "node-24",
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 1, factor: 1, minTimeoutInMs: 1000, maxTimeoutInMs: 1000 },
  },
  build: { conditions: ["react-server"] },
})
