import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HostApiError } from "@walkdiff/providers"
import type { GitHost, PullRequestRef } from "@walkdiff/providers"
import { commitShaSchema, REVIEW_MODEL_SCHEMA_VERSION } from "@walkdiff/review-model"
import type { PullRequestStack, PullRequestStatus, ReviewModel, ReviewSummary } from "@walkdiff/review-model"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { API_KEY_HEADER, startAppServer } from "./appServer.ts"
import type { AppServer } from "./appServer.ts"
import { ReviewService } from "./reviewService.ts"
import type { StackFinder } from "./reviewService.ts"
import { ReviewStore } from "./reviewStore.ts"

const KEY = "test-key"
const HEAD = commitShaSchema.parse("a".repeat(40))
const NEWER = commitShaSchema.parse("b".repeat(40))
const url = (number: number): string => `https://gitlab.com/acme/app/-/merge_requests/${number}`

function fakeModel(number: number): ReviewModel {
  return {
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: "2026-11-06T00:00:00.000Z",
    pullRequest: { host: "gitlab", url: url(number), repositoryWebUrl: "https://gitlab.com/acme/app", number, title: `MR ${number}`, description: "", author: "ana", baseRef: number === 3 ? "master" : `b${number - 1}`, headRef: `b${number}`, baseSha: HEAD, headSha: HEAD, mergeBaseSha: HEAD },
    files: [],
    risk: { securityLevel: "low", findings: [], checksRun: [], notChecked: [] },
    ai: { status: "disabled" },
    testCoverage: null,
    feedbackUrl: null,
  }
}

/** A stack of these MR numbers, each based on the one before it, the first into master. */
function stackOf(...numbers: number[]): PullRequestStack {
  return {
    source: "host",
    trunk: "master",
    members: numbers.map((number, index) => ({ number, title: `MR ${number}`, author: "ana", headRef: `b${number}`, baseRef: index === 0 ? "master" : `b${numbers[index - 1] ?? 0}` })),
    leftOut: [],
  }
}

interface Harness {
  readonly store: ReviewStore
  readonly service: ReviewService
  /** Every analysis run, as `number:ai`. */
  readonly analyzed: string[]
  readonly logged: string[]
}

describe("stacks in the app", () => {
  let dir = ""
  let harness: Harness
  /** What detection finds for each MR number; anything else stands alone. */
  let found: Map<number, PullRequestStack>

  const finder: StackFinder = async (ref) => {
    if (ref.number === 99) throw new HostApiError(500, url(99), "GitLab is down")
    return found.get(ref.number)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-stacks-"))
    found = new Map()
    const store = new ReviewStore(join(dir, "walkdiff.db"), () => new Date("2026-11-06T10:00:00.000Z"))
    const analyzed: string[] = []
    const logged: string[] = []
    const service = new ReviewService(store, {
      generate: async ({ ref, ai }) => {
        analyzed.push(`${ref.number}:${ai}`)
        return { model: fakeModel(ref.number), reportDir: dir }
      },
      findStack: finder,
      log: (message) => logged.push(message),
    })
    harness = { store, service, analyzed, logged }
  })

  afterEach(async () => {
    harness.store.close()
    await rm(dir, { recursive: true, force: true })
  })

  const added = async (number: number, ai = false): Promise<number> => {
    const { id } = harness.service.add({ url: url(number), ai })
    await harness.service.idle()
    return id
  }
  const reviewOf = (number: number): ReviewSummary | undefined => harness.service.list().find((review) => review.url === url(number))
  const positions = (): readonly string[] =>
    harness.service
      .list()
      .filter((review) => review.stack !== null)
      .toSorted((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0))
      .map((review) => `${review.displayName}@${review.stack?.position ?? 0}`)

  describe("detection", () => {
    it("offers the stack found while the review is analyzed, without the review itself", async () => {
      found.set(4, stackOf(3, 4, 5))
      await added(4)
      expect(reviewOf(4)).toMatchObject({ status: "ready", stack: null, stackOffer: { trunk: "master", joining: [3, 5] } })
    })

    it("offers nothing for an MR that stands alone", async () => {
      await added(4)
      expect(reviewOf(4)?.stackOffer).toBeNull()
    })

    it("logs a failed detection, and the review still succeeds", async () => {
      await added(99)
      expect(reviewOf(99)).toMatchObject({ status: "ready", stackOffer: null })
      expect(harness.logged.join()).toContain("GitLab is down")
    })

    it("forgets an earlier stack once the MR stands alone", async () => {
      found.set(4, stackOf(3, 4))
      const id = await added(4)
      found.delete(4)
      harness.service.refresh(id)
      await harness.service.idle()
      expect(reviewOf(4)?.stackOffer).toBeNull()
    })
  })

  describe("accepting the offer", () => {
    it("adds the missing members with the AI choice made now, and groups them bottom first", async () => {
      found.set(4, stackOf(3, 4, 5))
      const id = await added(4)
      expect(harness.service.acceptStack(id, { ai: true })).toMatchObject({ stack: { position: 2 }, stackOffer: null })
      await harness.service.idle()
      expect(harness.analyzed).toEqual(["4:false", "3:true", "5:true"])
      expect(positions()).toEqual(["acme/app!3@1", "acme/app!4@2", "acme/app!5@3"])
    })

    it("groups members already on the list without analyzing them again", async () => {
      found.set(4, stackOf(3, 4))
      await added(3)
      const id = await added(4)
      harness.service.acceptStack(id, { ai: true })
      await harness.service.idle()
      expect(harness.analyzed).toEqual(["3:false", "4:false"])
      expect(reviewOf(3)).toMatchObject({ ai: false, stack: { position: 1 } })
    })

    it("does nothing more when accepted twice", async () => {
      found.set(4, stackOf(3, 4))
      const id = await added(4)
      harness.service.acceptStack(id, { ai: false })
      harness.service.acceptStack(id, { ai: false })
      await harness.service.idle()
      expect(harness.service.list()).toHaveLength(2)
      expect(harness.store.list().map((review) => review.stack?.id)).toEqual([1, 1])
    })

    it("adds a PR that joins later to the same stack, keeping the merged bottom in place", async () => {
      found.set(4, stackOf(3, 4))
      const id = await added(4)
      harness.service.acceptStack(id, { ai: false })
      await harness.service.idle()
      // MR 3 merged, and MR 5 was stacked on top.
      found.set(4, stackOf(4, 5))
      harness.service.refresh(id)
      await harness.service.idle()
      expect(reviewOf(4)?.stackOffer?.joining).toEqual([5])
      harness.service.acceptStack(id, { ai: false })
      await harness.service.idle()
      expect(positions()).toEqual(["acme/app!3@1", "acme/app!4@2", "acme/app!5@3"])
    })

    it("only ever adds MRs from the reviewed project", async () => {
      found.set(4, stackOf(3, 4))
      harness.service.acceptStack(await added(4), { ai: false })
      expect(harness.store.list().map((review) => review.url).toSorted()).toEqual([url(3), url(4)])
    })
  })

  describe("turning it down and taking it apart", () => {
    it("doesn't offer dismissed members again, but does offer one that joins later", async () => {
      found.set(4, stackOf(3, 4))
      const id = await added(4)
      expect(harness.service.dismissStackOffer(id)?.stackOffer).toBeNull()
      found.set(4, stackOf(3, 4, 5))
      harness.service.refresh(id)
      await harness.service.idle()
      expect(reviewOf(4)?.stackOffer?.joining).toEqual([5])
    })

    it("ungroups a stack, keeping its reviews and offering it to none of them", async () => {
      found.set(4, stackOf(3, 4))
      found.set(3, stackOf(3, 4))
      const id = await added(4)
      harness.service.acceptStack(id, { ai: false })
      await harness.service.idle()
      expect(harness.service.ungroup(1)).toBe(true)
      expect(harness.service.list().map((review) => [review.stack, review.stackOffer])).toEqual([
        [null, null],
        [null, null],
      ])
      expect(harness.service.ungroup(1)).toBe(false)
    })

    it("drops a removed member from its stack without offering it back", async () => {
      found.set(4, stackOf(3, 4, 5))
      const id = await added(4)
      harness.service.acceptStack(id, { ai: false })
      await harness.service.idle()
      harness.service.remove(reviewOf(5)?.id ?? 0)
      expect(positions()).toEqual(["acme/app!3@1", "acme/app!4@2"])
      expect(reviewOf(4)?.stackOffer).toBeNull()
    })

    it("ungroups a stack left with one member", async () => {
      found.set(4, stackOf(3, 4))
      const id = await added(4)
      harness.service.acceptStack(id, { ai: false })
      await harness.service.idle()
      harness.service.remove(reviewOf(3)?.id ?? 0)
      expect(reviewOf(4)?.stack).toBeNull()
      expect(harness.store.stack(1)).toBeUndefined()
    })
  })

  it("keeps an existing list when opening it with the stack columns added", () => {
    harness.store.close()
    const path = join(dir, "old.db")
    const old = new DatabaseSync(path)
    // The reviews table and settings as the app before stacks left them.
    old.exec(`CREATE TABLE reviews (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, host TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL, error TEXT, report_dir TEXT, ai INTEGER NOT NULL, title TEXT, author TEXT, security_level TEXT, units_to_review INTEGER, untouched_references INTEGER, findings INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, coverage_source TEXT, attached_coverage TEXT)`)
    old.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`)
    old.exec(`INSERT INTO reviews (url, host, display_name, status, ai, created_at, updated_at) VALUES ('${url(4)}', 'gitlab', 'acme/app!4', 'ready', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`)
    old.exec("PRAGMA user_version = 4")
    old.close()
    harness = { ...harness, store: new ReviewStore(path, () => new Date()) }
    expect(harness.store.list()).toMatchObject([{ displayName: "acme/app!4", stack: null }])
    expect(harness.store.analyzedHeadOf(1)).toBeUndefined()
  })
})

describe("the stack endpoints", () => {
  let dir = ""
  let store: ReviewStore
  let service: ReviewService
  let server: AppServer
  let analyzed: number[] = []
  /** What each MR's host says now; a missing one fails, as an expired token would. */
  let statuses: Map<number, PullRequestStatus>
  const headers = { [API_KEY_HEADER]: KEY, "Content-Type": "application/json" }

  const hostFor = async (ref: PullRequestRef): Promise<GitHost> => ({
    fetchPullRequest: async () => {
      throw new Error("not used")
    },
    fetchStatus: async () => {
      const status = statuses.get(ref.number)
      if (status === undefined) throw new HostApiError(401, url(ref.number), "Token expired")
      return status
    },
    upsertComment: async () => undefined,
    fetchConversation: async () => ({ reviewers: [{ name: "ana", state: "approved" }], threads: [], truncated: false }),
    submitReview: async () => ({ url: "" }),
    replyToThread: async () => undefined,
    setThreadResolved: async () => undefined,
    fetchCoverageArchives: async () => [],
    fetchStack: async () => undefined,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-stack-api-"))
    analyzed = []
    store = new ReviewStore(join(dir, "walkdiff.db"), () => new Date("2026-11-06T10:00:00.000Z"))
    service = new ReviewService(store, {
      generate: async ({ ref }) => {
        analyzed.push(ref.number)
        return { model: fakeModel(ref.number), reportDir: dir }
      },
      findStack: async (ref) => (ref.number <= 5 ? stackOf(3, 4, 5) : undefined),
      log: () => undefined,
    })
    server = await startAppServer(store, service, { port: 0, apiKey: KEY, log: () => undefined, hostFor })
    statuses = new Map([3, 4, 5].map((number) => [number, { state: "open", headSha: HEAD, baseRef: number === 3 ? "master" : `b${number - 1}` }]))
  })

  afterEach(async () => {
    await server.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  const call = (path: string, method: string, body?: unknown): Promise<Response> => fetch(`${server.url}api/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const grouped = async (): Promise<number> => {
    const { id } = service.add({ url: url(4), ai: false })
    await service.idle()
    expect((await call(`reviews/${id}/stack`, "POST", { ai: false })).status).toBe(202)
    await service.idle()
    analyzed = []
    return store.get(id)?.stack?.id ?? 0
  }

  it("needs the key", async () => {
    expect((await fetch(`${server.url}api/stacks/1`)).status).toBe(401)
    expect((await fetch(`${server.url}api/reviews/1/stack`, { method: "POST", body: JSON.stringify({ ai: false }) })).status).toBe(401)
  })

  it("accepts and dismisses an offer, and explains a bad request", async () => {
    const { id } = service.add({ url: url(4), ai: false })
    await service.idle()
    expect((await call(`reviews/${id}/stack`, "POST", {})).status).toBe(400)
    expect((await call("reviews/999/stack", "POST", { ai: false })).status).toBe(404)
    const dismissed = await call(`reviews/${id}/stack`, "DELETE")
    expect(dismissed.status).toBe(200)
    expect(await dismissed.json()).toMatchObject({ stackOffer: null })
  })

  it("shows each member's state from the host, bottom first", async () => {
    const stackId = await grouped()
    statuses.set(4, { state: "open", headSha: NEWER, baseRef: "b3" })
    statuses.set(3, { state: "merged", headSha: HEAD, baseRef: "master" })
    const response = await call(`stacks/${stackId}`, "GET")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      trunk: "master",
      members: [
        { check: "checked", status: { state: "merged" }, reportChange: "none", reviewers: [{ name: "ana", state: "approved" }] },
        { check: "checked", status: { headSha: NEWER }, reportChange: "newCommits" },
        { check: "checked", reportChange: "none" },
      ],
    })
  })

  it("shows a member its host couldn't be asked about, and still reads the rest", async () => {
    const stackId = await grouped()
    statuses.delete(5)
    const view: unknown = await (await call(`stacks/${stackId}`, "GET")).json()
    expect(view).toMatchObject({ members: [{ check: "checked" }, { check: "checked" }, { check: "failed", error: expect.stringContaining("Token expired") }] })
  })

  it("refreshes only the members whose reports are out of date", async () => {
    const stackId = await grouped()
    // MR 4 was retargeted after the MR below merged, and MR 5 has new commits.
    statuses.set(4, { state: "open", headSha: HEAD, baseRef: "master" })
    statuses.set(5, { state: "open", headSha: NEWER, baseRef: "b4" })
    expect((await call(`stacks/${stackId}/refresh`, "POST")).status).toBe(202)
    await service.idle()
    expect(analyzed).toEqual([4, 5])
  })

  it("ungroups a stack and keeps its reviews", async () => {
    const stackId = await grouped()
    expect((await call(`stacks/${stackId}`, "DELETE")).status).toBe(200)
    expect((await call(`stacks/${stackId}`, "GET")).status).toBe(404)
    expect(store.list().map((review) => review.stack)).toEqual([null, null, null])
  })
})
