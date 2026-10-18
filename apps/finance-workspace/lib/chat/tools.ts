import { tool } from "ai"
import { z } from "zod"

/** Deliberately synthetic, read-only and incapable of accessing financial data. */
export const workspaceChatTools = {
  inspect_workspace: tool({
    description: "Read the synthetic workspace capabilities. Does not read documents, make financial decisions or mutate anything.",
    inputSchema: z.object({}).strict(),
    execute: async () => ({
      app: "Praeco",
      specialists: ["Vera", "Kael", "Nova"],
      financialToolsConnected: false,
      documentToolsConnected: false,
      sandboxToolsConnected: false,
      syntheticOnly: true,
    }),
  }),
}
