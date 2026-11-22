import { REVIEW_MODEL_SCHEMA_VERSION } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { AppClient, AppGoneError, AppRequestError, AppVersionError, SUPPORTED_API_VERSION } from "./appClient.ts"
import type { Fetch } from "./appClient.ts"

const CONNECTION = { url: "http://127.0.0.1:4317/", apiKey: "secret", apiVersion: 1, version: "0.14.0", pid: 42 }
const LISTING = { url: "https://github.com/acme/app/pull/7", host: "github", displayName: "acme/app#7", repository: "acme/app", number: 7, title: "Cap retries", author: "dev", draft: false, updatedAt: "2026-11-20T09:30:00Z" }

interface Sent {
  readonly url: string
  readonly init: RequestInit | undefined
}

function answering(status: number, body: unknown, sent: Sent[] = []): Fetch {
  return async (url, init) => {
    sent.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }
}

describe("AppClient", () => {
  it("sends the key and reads the answer with the app's own schemas", async () => {
    const sent: Sent[] = []
    const client = new AppClient(CONNECTION, answering(200, [LISTING], sent))
    expect(await client.openPullRequests("git@github.com:acme/app.git", "fix/retries")).toEqual([LISTING])
    expect(sent[0]?.url).toBe("http://127.0.0.1:4317/api/pull-requests?remote=git%40github.com%3Aacme%2Fapp.git&branch=fix%2Fretries")
    expect(new Headers(sent[0]?.init?.headers).get("x-walkdiff-key")).toBe("secret")
  })

  it("posts a review as JSON", async () => {
    const sent: Sent[] = []
    await new AppClient(CONNECTION, answering(400, { error: "Expected a pull request URL" }, sent))
      .addReview("x", false)
      .catch(() => undefined)
    expect(sent[0]?.init?.method).toBe("POST")
    expect(sent[0]?.init?.body).toBe(JSON.stringify({ url: "x", ai: false }))
  })

  it("passes on the app's own error message", async () => {
    const client = new AppClient(CONNECTION, answering(403, { error: "Walkdiff needs your GitHub login." }))
    await expect(client.reviewRequests("git@github.com:acme/app.git")).rejects.toThrow(new AppRequestError(403, "Walkdiff needs your GitHub login."))
  })

  it("posts a review, and replies and resolves by the host's thread id", async () => {
    const sent: Sent[] = []
    const client = new AppClient(CONNECTION, answering(201, { url: "https://github.com/acme/app/pull/7#pullrequestreview-1" }, sent))
    const review = { event: "approve", body: "", headSha: "a".repeat(40), comments: [] } as const
    expect(await client.submit(4, review)).toEqual({ url: "https://github.com/acme/app/pull/7#pullrequestreview-1" })
    await client.reply(4, "PRRT_kw/1", "Fixed")
    await client.setResolved(4, "PRRT_kw/1", true)
    expect(sent.map(({ url, init }) => [init?.method, url.replace(CONNECTION.url, ""), init?.body])).toEqual([
      ["POST", "api/reviews/4/submit", JSON.stringify(review)],
      ["POST", "api/reviews/4/threads/PRRT_kw%2F1/reply", JSON.stringify({ body: "Fixed" })],
      ["POST", "api/reviews/4/threads/PRRT_kw%2F1/resolve", JSON.stringify({ resolved: true })],
    ])
  })

  it("reads a file missing at one side as absent", async () => {
    expect(await new AppClient(CONNECTION, answering(404, { error: "No such file" })).file(1, "base", "src/new.ts")).toBeUndefined()
    expect(await new AppClient(CONNECTION, answering(200, { path: "a", side: "head", commit: "c", text: "hi\n" })).file(1, "head", "a")).toBe("hi\n")
  })

  it("tells a stopped or restarted app apart from an error", async () => {
    const refused: Fetch = async () => Promise.reject(new TypeError("fetch failed"))
    await expect(new AppClient(CONNECTION, refused).reviews()).rejects.toThrow(AppGoneError)
    await expect(new AppClient(CONNECTION, answering(401, { error: "The app was restarted." })).reviews()).rejects.toThrow(AppGoneError)
  })

  it.each([
    [SUPPORTED_API_VERSION + 1, REVIEW_MODEL_SCHEMA_VERSION, "Update the Walkdiff extension"],
    [SUPPORTED_API_VERSION, REVIEW_MODEL_SCHEMA_VERSION - 1, "Update Walkdiff (npx walkdiff@latest app)"],
  ])("says which side to update when the app speaks API %i and reports %i", async (apiVersion, reportSchemaVersion, advice) => {
    const client = new AppClient(CONNECTION, answering(200, { apiVersion, reportSchemaVersion, version: "0.14.0" }))
    await expect(client.checkVersions()).rejects.toThrow(AppVersionError)
    await expect(client.checkVersions()).rejects.toThrow(advice)
  })

  it("accepts the versions it was written for, and links to a report page", async () => {
    const client = new AppClient(CONNECTION, answering(200, { apiVersion: SUPPORTED_API_VERSION, reportSchemaVersion: REVIEW_MODEL_SCHEMA_VERSION, version: "0.14.0" }))
    await expect(client.checkVersions()).resolves.toBeUndefined()
    expect(client.reportPageUrl(3)).toBe("http://127.0.0.1:4317/reviews/3")
  })
})
