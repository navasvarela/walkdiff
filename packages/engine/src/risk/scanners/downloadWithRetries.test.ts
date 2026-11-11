import { describe, expect, it } from "vitest"
import { downloadWithRetries } from "./downloadWithRetries.ts"
import type { DownloadDependencies } from "./downloadWithRetries.ts"

const URL = "https://example.test/scanner.tar.gz"
const BYTES = Buffer.from("scanner")

type Reply = number | Error | "brokenBody"

/** Answers each request with the next reply: a status, a rejection, or a body that fails mid-read. */
function server(replies: readonly Reply[]): { readonly deps: DownloadDependencies; readonly waits: number[]; readonly logs: string[]; readonly requests: () => number } {
  const waits: number[] = []
  const logs: string[] = []
  let requests = 0
  const deps: DownloadDependencies = {
    fetch: async () => {
      const reply = replies.at(requests) ?? 200
      requests += 1
      if (reply instanceof Error) throw reply
      if (reply === "brokenBody") return brokenBodyResponse()
      return new Response(reply === 200 ? BYTES : null, { status: reply })
    },
    wait: async (ms) => void waits.push(ms),
    log: (message) => void logs.push(message),
  }
  return { deps, waits, logs, requests: () => requests }
}

function brokenBodyResponse(): Response {
  const body = new ReadableStream({ pull: (controller) => controller.error(new TypeError("terminated")) })
  return new Response(body, { status: 200 })
}

const connectionReset = new TypeError("fetch failed", { cause: new Error("read ECONNRESET") })

describe("downloadWithRetries", () => {
  it.each<[string, readonly Reply[], number]>([
    ["a gateway timeout", [504], 1],
    ["a rate limit", [429], 1],
    ["a dropped connection", [connectionReset], 1],
    ["a body cut off mid-download", ["brokenBody"], 1],
    ["three server errors in a row", [502, 503, 504], 3],
  ])("tries again after %s", async (_case, replies, retries) => {
    const { deps, waits } = server(replies)
    expect(await downloadWithRetries(URL, deps)).toEqual(BYTES)
    expect(waits).toHaveLength(retries)
  })

  it("waits longer each time, and says why it's waiting", async () => {
    const { deps, waits, logs } = server([504, connectionReset])
    await downloadWithRetries(URL, deps)
    expect(waits).toEqual([2_000, 8_000])
    expect(logs).toEqual([
      `Downloading ${URL} failed (responded 504). Trying again in 2 seconds.`,
      `Downloading ${URL} failed (fetch failed: read ECONNRESET). Trying again in 8 seconds.`,
    ])
  })

  it("gives up after four tries, naming the last problem", async () => {
    const { deps, requests } = server([504, 504, 504, 503])
    await expect(downloadWithRetries(URL, deps)).rejects.toThrow(`${URL} failed 4 times, last with: responded 503`)
    expect(requests()).toBe(4)
  })

  it.each<[string, Reply, string]>([
    ["a missing file", 404, `${URL} responded 404`],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "due to timeout"],
  ])("doesn't try again after %s", async (_case, reply, message) => {
    const { deps, waits } = server([reply])
    await expect(downloadWithRetries(URL, deps)).rejects.toThrow(message)
    expect(waits).toEqual([])
  })
})
