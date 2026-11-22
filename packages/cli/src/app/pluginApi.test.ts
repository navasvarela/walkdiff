import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { commitShaSchema, REVIEW_MODEL_SCHEMA_VERSION, reviewModelSchema } from "@walkdiff/review-model"
import type { CommitSha, PullRequestListing, ReviewModel } from "@walkdiff/review-model"
import { HostApiError, NotSignedInError } from "@walkdiff/providers"
import type { PullRequestDirectory, RepositoryRef } from "@walkdiff/providers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { API_KEY_HEADER, PLUGIN_API_VERSION, startAppServer } from "./appServer.ts"
import type { AppServer } from "./appServer.ts"
import { CONNECTION_FILE, writeConnectionFile } from "./connectionFile.ts"
import { ReviewService } from "./reviewService.ts"
import { ReviewStore } from "./reviewStore.ts"

const runFile = promisify(execFile)
const COMMITTER_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}
const KEY = "plugin-test-key"
const PR_URL = "https://github.com/acme/app/pull/7"

function modelFor(base: CommitSha, head: CommitSha): ReviewModel {
  const text = { kind: "text", hunks: [] } as const
  return reviewModelSchema.parse({
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: "2026-11-22T00:00:00.000Z",
    pullRequest: { host: "github", url: PR_URL, repositoryWebUrl: "https://github.com/acme/app", number: 7, title: "Cap retries", description: "", author: "dev", baseRef: "main", headRef: "x", baseSha: base, headSha: head, mergeBaseSha: base },
    files: [
      { diff: { status: "modified", path: "src/retry.ts", additions: 1, deletions: 1, content: text }, noise: null, syntax: { status: "unsupportedLanguage" } },
      { diff: { status: "added", path: "src/limits.ts", additions: 1, deletions: 0, content: text }, noise: null, syntax: { status: "unsupportedLanguage" } },
    ],
    risk: { securityLevel: "low", findings: [], checksRun: [], notChecked: [] },
    ai: { status: "disabled" },
    feedbackUrl: null,
  })
}

describe("the API for editor plugins", () => {
  let dir = ""
  let store: ReviewStore
  let server: AppServer
  let id = 0
  const headers = { [API_KEY_HEADER]: KEY, "Content-Type": "application/json" }
  const get = (path: string): Promise<Response> => fetch(`${server.url}${path}`, { headers })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-plugin-api-"))
    const repoDir = join(dir, "repo")
    const reportDir = join(dir, "report")
    await mkdir(join(repoDir, "src"), { recursive: true })
    await mkdir(reportDir, { recursive: true })
    const git = async (...args: string[]): Promise<string> => (await runFile("git", args, { cwd: repoDir, env: COMMITTER_ENV })).stdout
    const commit = async (files: Readonly<Record<string, string>>): Promise<CommitSha> => {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true })
        await writeFile(join(repoDir, path), text)
      }
      await git("add", "--all")
      await git("commit", "--quiet", "--message", "change")
      return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
    }
    await git("init", "--quiet")
    const base = await commit({ "src/retry.ts": "export const retries = 3\n", ".env": "SECRET=1\n" })
    const head = await commit({ "src/retry.ts": "export const retries = 5\n", "src/limits.ts": "export const limit = 10\n" })
    await writeFile(join(reportDir, "review.json"), JSON.stringify(modelFor(base, head)))
    await writeFile(join(reportDir, "index.html"), "<html><head></head><body>report</body></html>")

    store = new ReviewStore(join(dir, "walkdiff.db"), () => new Date("2026-11-22T10:00:00.000Z"))
    const service = new ReviewService(store, { generate: async () => ({ model: modelFor(base, head), reportDir, repoDir }), findStack: async () => undefined, log: () => undefined })
    server = await startAppServer(store, service, { port: 0, apiKey: KEY, log: () => undefined, describeChecks: async () => [] })
    const added: unknown = await (await fetch(`${server.url}api/reviews`, { method: "POST", headers, body: JSON.stringify({ url: PR_URL, ai: false }) })).json()
    id = typeof added === "object" && added !== null && "id" in added && typeof added.id === "number" ? added.id : 0
    await new Promise((done) => setTimeout(done, 50))
  })

  afterAll(async () => {
    await server.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("says which API and report format it speaks", async () => {
    expect(await (await get("api/info")).json()).toEqual({ apiVersion: PLUGIN_API_VERSION, reportSchemaVersion: REVIEW_MODEL_SCHEMA_VERSION, version: expect.any(String) })
  })

  it("needs the key for every new endpoint", async () => {
    for (const path of ["api/info", `api/reviews/${id}/report`, `api/reviews/${id}/file?side=head&path=src/retry.ts`]) {
      expect((await fetch(`${server.url}${path}`)).status).toBe(401)
    }
  })

  it("serves a review's report as data", async () => {
    const report: unknown = await (await get(`api/reviews/${id}/report`)).json()
    expect(reviewModelSchema.parse(report).pullRequest.title).toBe("Cap retries")
    expect((await get("api/reviews/999/report")).status).toBe(404)
  })

  it("serves a changed file at the PR's base or head", async () => {
    expect(await (await get(`api/reviews/${id}/file?side=base&path=src/retry.ts`)).json()).toMatchObject({ side: "base", text: "export const retries = 3\n" })
    expect(await (await get(`api/reviews/${id}/file?side=head&path=src/retry.ts`)).json()).toMatchObject({ side: "head", text: "export const retries = 5\n" })
    expect(await (await get(`api/reviews/${id}/file?side=head&path=src/limits.ts`)).json()).toMatchObject({ text: "export const limit = 10\n" })
  })

  it("says when a file isn't there, and serves nothing the PR doesn't change", async () => {
    expect((await get(`api/reviews/${id}/file?side=base&path=src/limits.ts`)).status).toBe(404)
    expect((await get(`api/reviews/${id}/file?side=base&path=.env`)).status).toBe(404)
    expect((await get(`api/reviews/${id}/file?side=middle&path=src/retry.ts`)).status).toBe(400)
    expect((await get(`api/reviews/${id}/file?side=head`)).status).toBe(400)
  })
})

describe("the connection file", () => {
  it("is readable by its owner only, and says where the app is and how to call it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "walkdiff-connection-"))
    try {
      await writeFile(join(dataDir, CONNECTION_FILE), "stale, and readable by anyone", { mode: 0o644 })
      const path = await writeConnectionFile(dataDir, { url: "http://127.0.0.1:4317/", apiKey: "k", apiVersion: PLUGIN_API_VERSION, version: "0.13.0", pid: 42 })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "http://127.0.0.1:4317/", apiKey: "k", apiVersion: PLUGIN_API_VERSION, version: "0.13.0", pid: 42 })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe("finding PRs to review", () => {
  const LISTED: PullRequestListing = { url: PR_URL, host: "github", displayName: "acme/app#7", repository: "acme/app", number: 7, title: "Cap retries", author: "dev", draft: false, updatedAt: "2026-11-20T09:30:00Z" }
  const asked: { repository?: RepositoryRef; branch?: string } = {}
  let dir = ""
  let store: ReviewStore
  let server: AppServer
  let awaitingMyReview: () => Promise<readonly PullRequestListing[]> = async () => [LISTED]
  const headers = { [API_KEY_HEADER]: KEY }
  const get = (path: string): Promise<Response> => fetch(`${server.url}${path}`, { headers })
  const directory: PullRequestDirectory = {
    openFromBranch: async (branch) => {
      asked.branch = branch
      return [LISTED]
    },
    awaitingMyReview: () => awaitingMyReview(),
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-lookup-"))
    store = new ReviewStore(join(dir, "walkdiff.db"), () => new Date("2026-11-22T10:00:00.000Z"))
    const service = new ReviewService(store, { generate: async () => Promise.reject(new Error("not used")), findStack: async () => undefined, log: () => undefined })
    const directoryFor = async (repository: RepositoryRef): Promise<PullRequestDirectory> => {
      asked.repository = repository
      return directory
    }
    server = await startAppServer(store, service, { port: 0, apiKey: KEY, log: () => undefined, describeChecks: async () => [], directoryFor })
  })

  afterAll(async () => {
    await server.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("finds the open PR for the branch a plugin has checked out", async () => {
    const response = await get(`api/pull-requests?remote=${encodeURIComponent("git@github.com:acme/app.git")}&branch=fix%2Fretries`)
    expect(await response.json()).toEqual([LISTED])
    expect(asked).toEqual({ repository: { host: "github", webOrigin: "https://github.com", owner: "acme", repo: "app" }, branch: "fix/retries" })
  })

  it("lists the PRs waiting for the user's review on that remote's host", async () => {
    expect(await (await get(`api/review-requests?remote=${encodeURIComponent("https://github.com/acme/app.git")}`)).json()).toEqual([LISTED])
  })

  it("says what's missing from a question it can't answer", async () => {
    expect((await get("api/pull-requests?branch=main")).status).toBe(400)
    expect((await get(`api/pull-requests?remote=${encodeURIComponent("git@github.com:acme/app.git")}`)).status).toBe(400)
    expect((await get(`api/review-requests?remote=${encodeURIComponent("git@git.example.org:acme/app.git")}`)).status).toBe(400)
  })

  it("passes on a missing login and the host's refusals", async () => {
    const remote = encodeURIComponent("git@github.com:acme/app.git")
    awaitingMyReview = () => Promise.reject(new NotSignedInError("Sign in"))
    expect((await get(`api/review-requests?remote=${remote}`)).status).toBe(403)
    awaitingMyReview = () => Promise.reject(new HostApiError(401, "https://api.github.com/search/issues", "Bad credentials"))
    const refused = await get(`api/review-requests?remote=${remote}`)
    expect(refused.status).toBe(502)
    expect(await refused.json()).toEqual({ error: expect.stringContaining("Bad credentials") })
  })
})
