import { DEFAULT_APP_SETTINGS } from "@walkdiff/review-model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAiProvider } from "./createAiProvider.ts"

const ANTHROPIC = DEFAULT_APP_SETTINGS.ai
// Closed on purpose: nothing listens here, which is the case that started this.
const CLOSED_PORT_URL = "http://localhost:20128"

describe("createAiProvider with ANTHROPIC_BASE_URL", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("reports Anthropic when nothing redirects it", () => {
    expect(createAiProvider(ANTHROPIC, {}).destination).toEqual({ label: "Anthropic", isLocal: false, ids: ["anthropic"] })
    expect(createAiProvider(ANTHROPIC, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }).destination.ids).toEqual(["anthropic"])
  })

  it.each([
    ["a proxy on this machine", CLOSED_PORT_URL, "localhost:20128"],
    ["a remote gateway", "https://gateway.example.com/anthropic", "gateway.example.com"],
  ])("names %s, and never as Anthropic or local", (_name, url, host) => {
    const { destination } = createAiProvider(ANTHROPIC, { ANTHROPIC_BASE_URL: url })
    expect(destination.label).toBe(`${host}, set by ANTHROPIC_BASE_URL`)
    expect(destination.isLocal).toBe(false)
    expect(destination.ids).toEqual([host])
  })

  it("refuses plain http to another machine, as the key and code would be readable", () => {
    expect(() => createAiProvider(ANTHROPIC, { ANTHROPIC_BASE_URL: "http://gateway.example.com" })).toThrow("ANTHROPIC_BASE_URL: Use https")
  })

  it("names the real address when it can't be reached", async () => {
    // The SDK reads its key from the real environment.
    vi.stubEnv("ANTHROPIC_API_KEY", "test")
    const provider = createAiProvider(ANTHROPIC, { ANTHROPIC_BASE_URL: CLOSED_PORT_URL })
    await expect(provider.checkConnection()).rejects.toThrow("could not reach localhost:20128, set by ANTHROPIC_BASE_URL")
  })
})
