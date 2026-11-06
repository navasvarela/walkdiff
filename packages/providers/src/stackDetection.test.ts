import { afterEach, describe, expect, it, vi } from "vitest"
import { gitHostFor } from "./gitHostFor.ts"
import { parsePullRequestUrl } from "./pullRequestUrl.ts"

const TOKENS = { github: "gh", gitlab: "gl", trustedOrigins: { github: [], gitlab: [] } }

interface Sent {
  readonly url: string
  readonly body: unknown
}

/** Answers each URL exactly as listed, and anything else with a 404, so an unexpected request fails the test. */
function stubHost(answers: Readonly<Record<string, unknown>>): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const text = String(url)
      sent.push({ url: text, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      return text in answers ? new Response(JSON.stringify(answers[text]), { status: 200 }) : new Response("{}", { status: 404 })
    }),
  )
  return sent
}

const numbersOf = (stack: { readonly members: readonly { readonly number: number }[] } | undefined): readonly number[] | undefined => stack?.members.map((member) => member.number)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("finding a GitHub stack", () => {
  const API = "https://api.github.com/repos/acme/app"
  const host = (): ReturnType<typeof gitHostFor> => gitHostFor(parsePullRequestUrl("https://github.com/acme/app/pull/7"), TOKENS)
  const repo = { full_name: "acme/app" }
  const pull = (number: number, base: string, head: string, headRepo: { readonly full_name: string } | null = repo): Record<string, unknown> => ({
    number,
    title: `PR ${number}`,
    user: { login: "ana" },
    base: { ref: base, repo: { ...repo, default_branch: "main" } },
    head: { ref: head, repo: headRepo },
  })

  it("reads GitHub's own stack, keeping only its open PRs", async () => {
    const sent = stubHost({
      [`${API}/pulls/7`]: { ...pull(7, "b6", "b7"), stack: { id: 1, number: 3, size: 4, position: 3 } },
      [`${API}/stacks/3`]: {
        pull_requests: [
          { number: 5, state: "closed", merged_at: "2026-11-01T00:00:00Z" },
          { number: 6, state: "open", merged_at: null },
          { number: 7, state: "open", merged_at: null },
          { number: 8, state: "open", merged_at: null },
        ],
      },
      [`${API}/pulls/6`]: pull(6, "main", "b6"),
      [`${API}/pulls/8`]: pull(8, "b7", "b8"),
    })
    const stack = await host().fetchStack()
    expect(stack).toMatchObject({ source: "host", trunk: "main", leftOut: [] })
    expect(numbersOf(stack)).toEqual([6, 7, 8])
    expect(stack?.members.at(2)).toEqual({ number: 8, title: "PR 8", author: "ana", headRef: "b8", baseRef: "b7" })
    expect(sent.some((request) => request.url.includes("/pulls?"))).toBe(false)
  })

  it("follows branches when the PR isn't in one of GitHub's stacks", async () => {
    stubHost({
      [`${API}/pulls/7`]: { ...pull(7, "b6", "b7"), stack: null },
      [`${API}/pulls?state=open&per_page=100&head=acme%3Ab6`]: [pull(6, "main", "b6")],
      [`${API}/pulls?state=open&per_page=100&base=b7`]: [pull(8, "b7", "b8", { full_name: "someone/app" })],
    })
    const stack = await host().fetchStack()
    expect(stack).toMatchObject({ source: "branches", trunk: "main" })
    // PR 8 comes from a fork, so nothing in this repository can build on its branch.
    expect(numbersOf(stack)).toEqual([6, 7, 8])
  })

  it("finds no stack for a PR into the default branch with nothing on it, on Enterprise Server", async () => {
    // Enterprise Server has no stacks, so its PRs have no `stack` field at all.
    const sent = stubHost({
      [`${API}/pulls/7`]: pull(7, "main", "b7"),
      [`${API}/pulls?state=open&per_page=100&base=b7`]: [],
    })
    expect(await host().fetchStack()).toBeUndefined()
    expect(sent.map((request) => request.url)).toEqual([`${API}/pulls/7`, `${API}/pulls?state=open&per_page=100&base=b7`])
  })
})

describe("finding a GitLab stack", () => {
  const PROJECT = "https://gitlab.com/api/v4/projects/acme%2Fapp"
  const GRAPHQL = "https://gitlab.com/api/graphql"
  const host = (number = 4): ReturnType<typeof gitHostFor> => gitHostFor(parsePullRequestUrl(`https://gitlab.com/acme/app/-/merge_requests/${number}`), TOKENS)
  const node = (iid: number, target: string, source: string): Record<string, unknown> => ({ iid: String(iid), title: `MR ${iid}`, author: { username: "ana" }, sourceBranch: source, targetBranch: target })
  const answer = (stack: readonly Record<string, unknown>[] | null): Record<string, unknown> => ({ data: { project: { mergeRequest: { ...node(4, "b3", "b4"), stack } } } })
  const listed = (iid: number, target: string, source: string, sourceProject = 1): Record<string, unknown> => ({
    iid,
    title: `MR ${iid}`,
    author: { username: "ana" },
    source_branch: source,
    target_branch: target,
    source_project_id: sourceProject,
    target_project_id: 1,
  })
  const branchAnswers = {
    [`${PROJECT}/merge_requests/4`]: listed(4, "b3", "b4"),
    [PROJECT]: { default_branch: "master" },
    [`${PROJECT}/merge_requests?state=opened&per_page=100&source_branch=b3`]: [listed(3, "master", "b3")],
    [`${PROJECT}/merge_requests?state=opened&per_page=100&target_branch=b4`]: [listed(5, "b4", "b5")],
    [`${PROJECT}/merge_requests?state=opened&per_page=100&target_branch=b5`]: [],
  }

  it.each([
    // gitlab.com 19.6 answered this way for a real stack.
    ["bottom first, with the MR itself", [node(3, "master", "b3"), node(4, "b3", "b4"), node(5, "b4", "b5")]],
    // GitLab's documentation describes this.
    ["top first, without the MR itself", [node(5, "b4", "b5"), node(3, "master", "b3")]],
  ])("reads GitLab's own stack given %s", async (_shape, stack) => {
    const sent = stubHost({ [GRAPHQL]: answer(stack) })
    const found = await host().fetchStack()
    expect(found).toMatchObject({ source: "host", trunk: "master", leftOut: [] })
    expect(numbersOf(found)).toEqual([3, 4, 5])
    expect(sent).toEqual([{ url: GRAPHQL, body: expect.objectContaining({ variables: { project: "acme/app", iid: "4" } }) }])
  })

  it("takes GitLab's word that an MR stands alone", async () => {
    const sent = stubHost({ [GRAPHQL]: answer([]) })
    expect(await host().fetchStack()).toBeUndefined()
    expect(sent).toHaveLength(1)
  })

  it.each([
    ["GitLab is older than 19.1", { errors: [{ message: "Field 'stack' doesn't exist on type 'MergeRequest'", extensions: { code: "undefinedField" } }] }],
    ["the stack is longer than GitLab shows", answer(null)],
    ["GitLab's members don't form one chain", answer([node(3, "master", "b3"), node(9, "master", "b9")])],
  ])("follows branches when %s", async (_case, graphql) => {
    stubHost({ [GRAPHQL]: graphql, ...branchAnswers })
    const found = await host().fetchStack()
    expect(found).toMatchObject({ source: "branches", trunk: "master" })
    expect(numbersOf(found)).toEqual([3, 4, 5])
  })

  it("stops at an MR from a fork, whose branch isn't in this project", async () => {
    stubHost({
      [GRAPHQL]: answer(null),
      ...branchAnswers,
      [`${PROJECT}/merge_requests?state=opened&per_page=100&target_branch=b4`]: [listed(5, "b4", "b5", 2)],
      // Based on this project's own b5, which has nothing to do with the fork's.
      [`${PROJECT}/merge_requests?state=opened&per_page=100&target_branch=b5`]: [listed(6, "b5", "b6")],
    })
    expect(numbersOf(await host().fetchStack())).toEqual([3, 4, 5])
  })

  it("fails on any other GraphQL error, though the status was 200", async () => {
    stubHost({ [GRAPHQL]: { errors: [{ message: "Rate limited" }] } })
    await expect(host().fetchStack()).rejects.toThrow("Rate limited")
  })
})

describe("reading a member's status", () => {
  const HEAD = "c".repeat(40)
  const NEWER = "d".repeat(40)
  const github = (): ReturnType<typeof gitHostFor> => gitHostFor(parsePullRequestUrl("https://github.com/acme/app/pull/7"), TOKENS)
  const gitlab = (): ReturnType<typeof gitHostFor> => gitHostFor(parsePullRequestUrl("https://gitlab.com/acme/app/-/merge_requests/4"), TOKENS)
  const githubPull = (state: string, mergedAt: string | null): Record<string, unknown> => ({ state, merged_at: mergedAt, base: { ref: "b6" }, head: { sha: HEAD } })

  it.each([
    ["open", null, "open"],
    ["closed", "2026-11-01T00:00:00Z", "merged"],
    ["closed", null, "closed"],
  ])("reads a GitHub PR that is %s, merged at %s, as %s", async (state, mergedAt, expected) => {
    const sent = stubHost({ "https://api.github.com/repos/acme/app/pulls/7": githubPull(state, mergedAt) })
    expect(await github().fetchStatus()).toEqual({ state: expected, headSha: HEAD, baseRef: "b6" })
    expect(sent).toHaveLength(1)
  })

  const mergeRequest = (state: string, diffHead: string | null): Record<string, unknown> => ({ state, target_branch: "b3", sha: NEWER, diff_refs: diffHead === null ? null : { head_sha: diffHead } })

  it.each([
    ["opened", "open"],
    ["locked", "open"],
    ["merged", "merged"],
    ["closed", "closed"],
  ])("reads a GitLab merge request that is %s as %s", async (state, expected) => {
    stubHost({ "https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/4": mergeRequest(state, HEAD) })
    // The head its diff was computed for, which is what a review is checked against.
    expect(await gitlab().fetchStatus()).toEqual({ state: expected, headSha: HEAD, baseRef: "b3" })
  })

  it("takes the GitLab head commit while the new diff is still being computed", async () => {
    stubHost({ "https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/4": mergeRequest("opened", null) })
    expect((await gitlab().fetchStatus()).headSha).toBe(NEWER)
  })
})
