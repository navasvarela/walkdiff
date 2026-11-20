import { commitShaSchema, HistoryUnavailableError } from "@walkdiff/review-model"
import { describe, expect, it, vi } from "vitest"
import type { z } from "zod"
import { githubFileHistory, gitlabFileHistory } from "./fileHistory.ts"
import type { GraphqlRunner, JsonGetter } from "./fileHistory.ts"
import { HostApiError } from "./http.ts"

const request = { paths: ["src/a.ts", "src/b.ts"], until: commitShaSchema.parse("a".repeat(40)), since: new Date("2025-06-01T00:00:00Z") }

describe("githubFileHistory", () => {
  it("asks for every file in one query, with the paths as variables", async () => {
    const graphql = vi.fn(async (_query: string, _variables: Readonly<Record<string, string>>, schema: z.ZodType<unknown>) =>
      schema.parse({
        repository: {
          object: {
            f0: { totalCount: 140, nodes: [{ oid: "c1", messageHeadline: "fix: totals", committedDate: "2026-05-01T00:00:00Z", author: { email: "a@example.com", user: { login: "ana" } } }] },
            f1: { totalCount: 0, nodes: [] },
          },
        },
      }),
    )
    const histories = await githubFileHistory(graphql as GraphqlRunner, "acme", "shop", request)
    expect(graphql).toHaveBeenCalledTimes(1)
    const [query, variables] = graphql.mock.calls[0] ?? []
    expect(variables).toMatchObject({ owner: "acme", name: "shop", oid: "a".repeat(40), since: "2025-06-01T00:00:00.000Z", p0: "src/a.ts", p1: "src/b.ts" })
    expect(query).not.toContain("src/a.ts")
    expect(histories.get("src/a.ts")).toEqual({ total: 140, commits: [{ sha: "c1", subject: "fix: totals", committedAt: "2026-05-01T00:00:00Z", author: "ana" }] })
    expect(histories.get("src/b.ts")?.total).toBe(0)
  })

  it("needs a token, and turns the host's errors into missing history", async () => {
    await expect(githubFileHistory(undefined, "acme", "shop", request)).rejects.toThrow(HistoryUnavailableError)
    const refusing: GraphqlRunner = async () => Promise.reject(new HostApiError(403, "https://api.github.com/graphql", "forbidden"))
    await expect(githubFileHistory(refusing, "acme", "shop", request)).rejects.toThrow(HistoryUnavailableError)
  })
})

describe("gitlabFileHistory", () => {
  it("lists each file's commits at the merge base", async () => {
    const get = vi.fn(async (url: string, schema: z.ZodType<unknown>) =>
      schema.parse(url.includes("src%2Fa.ts") ? [{ id: "c1", title: "fix: totals", committed_date: "2026-05-01T00:00:00Z", author_email: "a@example.com" }] : []),
    )
    const histories = await gitlabFileHistory(get as JsonGetter, "https://gitlab.com/api/v4/projects/1", request)
    expect(get).toHaveBeenCalledTimes(2)
    expect(String(get.mock.calls[0]?.[0])).toBe(`https://gitlab.com/api/v4/projects/1/repository/commits?ref_name=${"a".repeat(40)}&path=src%2Fa.ts&since=2025-06-01T00%3A00%3A00.000Z&per_page=100`)
    expect(histories.get("src/a.ts")).toEqual({ total: 1, commits: [{ sha: "c1", subject: "fix: totals", committedAt: "2026-05-01T00:00:00Z", author: "a@example.com" }] })
    expect(histories.get("src/b.ts")?.total).toBe(0)
  })
})
