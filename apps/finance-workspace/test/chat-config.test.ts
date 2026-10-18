import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { readChatConfiguration, readModelConfiguration } from "@/lib/chat/config"

const modelOnly = {
  OPENROUTER_API_KEY: "synthetic-only",
  OPENROUTER_MODEL: "anthropic/synthetic-model",
}

describe("server and worker chat configuration boundaries", () => {
  it("allows the Trigger model worker to read OpenRouter settings without its runtime-owned Trigger secret", () => {
    expect(readModelConfiguration(modelOnly)).toEqual(modelOnly)
  })

  it("requires Trigger credentials for server-side chat control actions", () => {
    expect(() => readChatConfiguration(modelOnly)).toThrow("CHAT_NOT_CONFIGURED")
    expect(readChatConfiguration({
      ...modelOnly,
      TRIGGER_PROJECT_REF: "proj_synthetic",
      TRIGGER_SECRET_KEY: "tr_dev_sk_synthetic",
    })).toMatchObject({ ...modelOnly, TRIGGER_PROJECT_REF: "proj_synthetic" })
  })
})
