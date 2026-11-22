import { afterEach, describe, expect, it, vi } from "vitest"
import type { HostTokens } from "./gitHost.ts"
import { NotSignedInError } from "./pullRequestDirectory.ts"
import type { PullRequestDirectory } from "./pullRequestDirectory.ts"
import { pullRequestDirectoryFor } from "./pullRequestDirectoryFor.ts"
import { parseRemoteUrl } from "./remoteUrl.ts"

const NO_TRUSTED = { github: [], gitlab: [] }
const TOKENS: HostTokens = { github: "gh", gitlab: "gl", trustedOrigins: NO_TRUSTED }
const NO_TOKENS: HostTokens = { github: undefined, gitlab: undefined, trustedOrigins: NO_TRUSTED }
const UPDATED = "2026-11-20T09:30:00Z"

interface Request {
  readonly url: URL
  readonly headers: Headers
}

/** Answers each request from a list of [path, JSON], and records what was asked. */
function stubHost(answers: readonly (readonly [string, unknown])[]): Request[] {
  const requests: Request[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url))
      requests.push({ url: parsed, headers: new Headers(init?.headers) })
      const answer = answers.find(([path]) => parsed.pathname === path)
      return new Response(JSON.stringify(answer?.[1] ?? []), { status: 200 })
    }),
  )
  return requests
}

const githubPull = (number: number, extra: object = {}): object => ({ html_url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, user: { login: "dev" }, updated_at: UPDATED, ...extra })
const gitlabMergeRequest = (number: number, sourceProject = 1): object => ({
  web_url: `https://gitlab.com/group/app/-/merge_requests/${number}`,
  title: `MR ${number}`,
  author: { username: "dev" },
  draft: false,
  updated_at: UPDATED,
  source_project_id: sourceProject,
  target_project_id: 1,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the GitHub directory", () => {
  const directory = (tokens: HostTokens = TOKENS): PullRequestDirectory => pullRequestDirectoryFor(parseRemoteUrl("git@github.com:acme/app.git", NO_TRUSTED), tokens)

  it("finds the open PRs from a branch of this repository", async () => {
    const requests = stubHost([["/repos/acme/app/pulls", [githubPull(7, { draft: true })]]])
    expect(await directory().openFromBranch("fix/retries")).toEqual([
      { url: "https://github.com/acme/app/pull/7", host: "github", displayName: "acme/app#7", repository: "acme/app", number: 7, title: "PR 7", author: "dev", draft: true, updatedAt: UPDATED },
    ])
    expect(requests[0]?.url.searchParams.get("head")).toBe("acme:fix/retries")
    expect(requests[0]?.url.searchParams.get("state")).toBe("open")
  })

  it("lists PRs anywhere on the host waiting for my review, as the token's user", async () => {
    const requests = stubHost([["/search/issues", { items: [githubPull(9, { html_url: "https://github.com/other/lib/pull/9", user: null })] }]])
    const [listed] = await directory().awaitingMyReview()
    expect(listed).toMatchObject({ displayName: "other/lib#9", repository: "other/lib", author: "ghost", draft: false })
    expect(requests[0]?.url.searchParams.get("q")).toBe("is:open is:pr review-requested:@me archived:false")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer gh")
  })

  it("can't say what waits for my review without a login", async () => {
    stubHost([])
    await expect(directory(NO_TOKENS).awaitingMyReview()).rejects.toThrow(NotSignedInError)
  })
})

describe("the GitLab directory", () => {
  const directory = (tokens: HostTokens = TOKENS): PullRequestDirectory => pullRequestDirectoryFor(parseRemoteUrl("git@gitlab.com:group/app.git", NO_TRUSTED), tokens)

  it("finds the open merge requests from this project's branch, not a fork's", async () => {
    const requests = stubHost([["/api/v4/projects/group%2Fapp/merge_requests", [gitlabMergeRequest(4), gitlabMergeRequest(5, 2)]]])
    expect((await directory().openFromBranch("fix/retries")).map((listed) => listed.displayName)).toEqual(["group/app!4"])
    expect(requests[0]?.url.searchParams.get("source_branch")).toBe("fix/retries")
  })

  it("lists merge requests I'm a reviewer on, across projects", async () => {
    const requests = stubHost([
      ["/api/v4/user", { username: "me" }],
      ["/api/v4/merge_requests", [gitlabMergeRequest(12)]],
    ])
    expect((await directory().awaitingMyReview()).map((listed) => listed.displayName)).toEqual(["group/app!12"])
    const search = requests.find((request) => request.url.pathname === "/api/v4/merge_requests")?.url.searchParams
    expect(search?.get("reviewer_username")).toBe("me")
    expect(search?.get("scope")).toBe("all")
    expect(requests[0]?.headers.get("private-token")).toBe("gl")
  })

  it("sends no token to a host the user doesn't trust", async () => {
    const requests = stubHost([["/api/v4/projects/group%2Fapp/merge_requests", []]])
    const untrusted = pullRequestDirectoryFor({ host: "gitlab", webOrigin: "https://gitlab.example.org", projectPath: "group/app" }, TOKENS)
    await untrusted.openFromBranch("main")
    expect(requests[0]?.headers.get("private-token")).toBeNull()
  })
})
