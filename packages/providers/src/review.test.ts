import { afterEach, describe, expect, it, vi } from "vitest"
import type { SubmitReview } from "@walkdiff/review-model"
import { gitHostFor } from "./gitHostFor.ts"
import { parsePullRequestUrl } from "./pullRequestUrl.ts"

const TOKENS = { github: "gh", gitlab: "gl", trustedOrigins: { github: [], gitlab: [] } }
const HEAD = "a".repeat(40)

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

/** Answers each request from a list of [url part, JSON], and records what was sent. */
function stubHost(answers: readonly (readonly [string, unknown])[]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const text = String(url)
      calls.push({ url: text, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      const answer = answers.find(([part]) => text.includes(part))
      return new Response(JSON.stringify(answer?.[1] ?? {}), { status: 200 })
    }),
  )
  return calls
}

const review = (overrides: Partial<SubmitReview> = {}): SubmitReview => ({ event: "comment", body: "Summary", headSha: HEAD, comments: [], ...overrides })
const onLine = { path: "a.ts", previousPath: "a.ts", line: 4, label: "run", range: null, body: "On a line" }
const noLine = { path: "b.ts", previousPath: "b.ts", line: null, label: "gone", range: null, body: "No line" }
// Lines 3 to 5 after the change, where line 3 is unchanged and so also has its old number, 2.
const onNewRange = { ...onLine, line: null, range: { side: "new", start: { oldLine: 2, newLine: 3 }, end: { oldLine: null, newLine: 5 } }, body: "On lines" } as const
const onOldLine = { ...onLine, line: null, range: { side: "old", start: { oldLine: 7, newLine: null }, end: { oldLine: 7, newLine: null } }, body: "Removed line" } as const
const onUnchangedLine = { ...onLine, line: null, range: { side: "new", start: { oldLine: 2, newLine: 3 }, end: { oldLine: 2, newLine: 3 } }, body: "Unchanged" } as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GitHub reviews", () => {
  const host = (): ReturnType<typeof gitHostFor> => gitHostFor(parsePullRequestUrl("https://github.com/o/r/pull/7"), TOKENS)

  it.each([
    ["comment", "COMMENT"],
    ["approve", "APPROVE"],
    ["requestChanges", "REQUEST_CHANGES"],
  ] as const)("posts a %s as %s, tied to the commit that was read", async (event, expected) => {
    const calls = stubHost([["/reviews", { html_url: "https://github.com/o/r/pull/7#r" }]])
    const { url } = await host().submitReview(review({ event, comments: [onLine] }))
    expect(url).toBe("https://github.com/o/r/pull/7#r")
    expect(calls.at(0)?.url).toBe("https://api.github.com/repos/o/r/pulls/7/reviews")
    expect(calls.at(0)?.body).toMatchObject({ event: expected, commit_id: HEAD, comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "On a line" }] })
  })

  it("posts picked lines as a range on the side they're on", async () => {
    const calls = stubHost([["/reviews", { html_url: "https://x" }]])
    await host().submitReview(review({ comments: [onNewRange, onOldLine] }))
    expect(calls.at(0)?.body).toMatchObject({
      comments: [
        { path: "a.ts", line: 5, side: "RIGHT", start_line: 3, start_side: "RIGHT", body: "On lines" },
        { path: "a.ts", line: 7, side: "LEFT", body: "Removed line" },
      ],
    })
  })

  it("moves a comment without a line into the review's text", async () => {
    const calls = stubHost([["/reviews", { html_url: "https://x" }]])
    await host().submitReview(review({ comments: [onLine, noLine] }))
    const body = calls.at(0)?.body
    expect(body).toMatchObject({ comments: [{ path: "a.ts" }] })
    expect(JSON.stringify(body)).toContain("No line")
  })

  it("reads threads and reviewers", async () => {
    stubHost([
      [
        "/graphql",
        {
          data: {
            repository: {
              pullRequest: {
                latestReviews: { nodes: [{ state: "APPROVED", author: { login: "ana" } }, { state: "DISMISSED", author: null }] },
                reviewThreads: {
                  pageInfo: { hasNextPage: true },
                  nodes: [{ id: "T1", isResolved: false, isOutdated: true, path: "a.ts", line: null, comments: { nodes: [{ bodyText: "Why?", createdAt: "2026-11-01", url: "https://x", author: { login: "bo" } }] } }],
                },
              },
            },
          },
        },
      ],
    ])
    const conversation = await host().fetchConversation()
    expect(conversation.reviewers).toEqual([{ name: "ana", state: "approved" }, { name: "ghost", state: "other" }])
    expect(conversation.threads.at(0)).toMatchObject({ id: "T1", path: "a.ts", isOutdated: true, comments: [{ author: "bo", body: "Why?" }] })
    expect(conversation.truncated).toBe(true)
  })

  it("treats a GraphQL error as a failure, though the status was 200", async () => {
    stubHost([["/graphql", { errors: [{ message: "Resource not accessible" }] }]])
    await expect(host().setThreadResolved("T1", true)).rejects.toThrow("Resource not accessible")
  })

  it("replies and resolves with the thread's id", async () => {
    const calls = stubHost([["/graphql", { data: {} }]])
    await host().replyToThread("T1", "Done")
    await host().setThreadResolved("T1", false)
    expect(calls.at(0)?.body).toMatchObject({ variables: { id: "T1", body: "Done" } })
    expect(JSON.stringify(calls.at(1)?.body)).toContain("unresolveReviewThread")
  })

  it("uses the Enterprise GraphQL address, on a trusted host", async () => {
    const calls = stubHost([["/graphql", { data: {} }]])
    await gitHostFor(parsePullRequestUrl("https://ghe.example/o/r/pull/7"), { ...TOKENS, trustedOrigins: { github: ["https://ghe.example"], gitlab: [] } }).replyToThread("T1", "x")
    expect(calls.at(0)?.url).toBe("https://ghe.example/api/graphql")
  })
})

describe("GitLab reviews", () => {
  const API = "https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/7"
  const mergeRequest = {
    web_url: "https://gitlab.com/g/p/-/merge_requests/7",
    iid: 7,
    title: "t",
    description: null,
    author: { username: "a" },
    source_branch: "s",
    target_branch: "m",
    diff_refs: { base_sha: "b".repeat(40), head_sha: HEAD, start_sha: "c".repeat(40) },
  }
  const host = (): ReturnType<typeof gitHostFor> => gitHostFor(parsePullRequestUrl("https://gitlab.com/g/p/-/merge_requests/7"), TOKENS)
  const answers = [
    ["/draft_notes", {}],
    ["/approve", {}],
    ["/merge_requests/7", mergeRequest],
  ] as const

  it("drafts comments, then publishes them with the decision", async () => {
    const calls = stubHost(answers)
    const { url } = await host().submitReview(review({ event: "requestChanges", comments: [{ ...onLine, previousPath: "old.ts" }, noLine] }))
    expect(url).toBe(mergeRequest.web_url)
    const writes = calls.filter((call) => call.method === "POST")
    expect(writes.at(0)).toMatchObject({ url: `${API}/draft_notes`, body: { note: "On a line", position: { new_path: "a.ts", old_path: "old.ts", new_line: 4, head_sha: HEAD, position_type: "text" } } })
    expect(JSON.stringify(writes.at(1)?.body)).toContain("No line")
    expect(writes.at(-1)).toMatchObject({ url: `${API}/draft_notes/bulk_publish`, body: { reviewer_state: "requested_changes" } })
  })

  it.each([
    ["an added line", onLine, { new_line: 4 }, "On a line"],
    ["an unchanged line, with both numbers", onUnchangedLine, { old_line: 2, new_line: 3 }, "Unchanged"],
    ["a removed line, by its old number", onOldLine, { old_line: 7 }, "Removed line"],
    ["a range, on its last line and naming the rest", onNewRange, { new_line: 5 }, "Lines 3–5:\n\nOn lines"],
  ] as const)("places a comment on %s", async (_name, comment, position, note) => {
    const calls = stubHost(answers)
    await host().submitReview(review({ comments: [comment] }))
    const posted = calls.find((call) => call.url === `${API}/draft_notes`)
    expect(posted?.body).toMatchObject({ note, position })
    // A number GitLab doesn't expect, such as an old one for an added line, makes it reject the note.
    const sent = JSON.stringify(posted?.body)
    expect(sent.includes('"old_line"')).toBe("old_line" in position)
    expect(sent.includes('"new_line"')).toBe("new_line" in position)
  })

  it("approves last, and for the commit that was read", async () => {
    const calls = stubHost(answers)
    await host().submitReview(review({ event: "approve", body: "" }))
    expect(calls.at(-1)).toMatchObject({ url: `${API}/approve`, body: { sha: HEAD } })
  })

  it("reads threads and reviewers, skipping system notes", async () => {
    stubHost([
      [
        "/discussions",
        [
          { id: "d1", individual_note: false, notes: [{ id: 5, body: "Why?", created_at: "2026", system: false, author: { username: "bo" }, resolvable: true, resolved: true, position: { new_path: "a.ts", new_line: 3 } }] },
          { id: "d2", individual_note: true, notes: [{ id: 6, body: "Plain note", created_at: "2026", system: false, author: { username: "bo" } }] },
        ],
      ],
      ["/approvals", { approved_by: [{ user: { username: "ana" } }] }],
      ["/reviewers", [{ user: { username: "ana" }, state: "approved" }, { user: { username: "cy" }, state: "requested_changes" }]],
    ])
    const conversation = await host().fetchConversation()
    expect(conversation.reviewers).toEqual([{ name: "ana", state: "approved" }, { name: "cy", state: "changesRequested" }])
    expect(conversation.threads).toHaveLength(1)
    expect(conversation.threads.at(0)).toMatchObject({ id: "d1", path: "a.ts", line: 3, isResolved: true, comments: [{ url: "https://gitlab.com/g/p/-/merge_requests/7#note_5" }] })
  })

  it("replies and resolves a discussion", async () => {
    const calls = stubHost([])
    await host().replyToThread("d1", "Done")
    await host().setThreadResolved("d1", true)
    expect(calls.at(0)).toMatchObject({ url: `${API}/discussions/d1/notes`, method: "POST", body: { body: "Done" } })
    expect(calls.at(1)).toMatchObject({ url: `${API}/discussions/d1`, method: "PUT", body: { resolved: true } })
  })
})
