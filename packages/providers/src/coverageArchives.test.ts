import { afterEach, describe, expect, it, vi } from "vitest"
import { gitHostFor } from "./gitHostFor.ts"
import { parsePullRequestUrl } from "./pullRequestUrl.ts"

const TOKENS = { github: "gh-secret", gitlab: "gl-secret", trustedOrigins: { github: [], gitlab: [] } }
const HEAD = "a".repeat(40)
const STORAGE = "https://storage.example.net/signed?sig=1"

interface Sent {
  readonly url: string
  readonly headers: unknown
}

function stub(answer: (url: string) => Response): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      sent.push({ url: String(url), headers: init?.headers })
      return answer(String(url))
    }),
  )
  return sent
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const github = () => gitHostFor(parsePullRequestUrl("https://github.com/acme/app/pull/7"), TOKENS)
const gitlab = () => gitHostFor(parsePullRequestUrl("https://gitlab.com/acme/app/-/merge_requests/7"), TOKENS)

function githubAnswers(url: string): Response {
  if (url.includes("/actions/runs?")) return json({ workflow_runs: [{ id: 1 }] })
  if (url.endsWith("/runs/1/artifacts?per_page=100")) {
    return json({
      artifacts: [
        { id: 10, name: "coverage", expired: false, size_in_bytes: 5 },
        { id: 11, name: "binaries", expired: false, size_in_bytes: 5 },
        { id: 12, name: "old-coverage", expired: true, size_in_bytes: 5 },
        { id: 13, name: "huge-coverage", expired: false, size_in_bytes: 1e12 },
      ],
    })
  }
  if (url.includes("/artifacts/10/zip")) return new Response(null, { status: 302, headers: { location: STORAGE } })
  return new Response("zip-bytes", { status: 200 })
}

describe("fetchCoverageArchives", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("downloads only live, sensibly named GitHub artifacts of this commit", async () => {
    const sent = stub(githubAnswers)
    const archives = await github().fetchCoverageArchives(HEAD)
    expect(archives.map((archive) => [archive.name, archive.zip.toString()])).toEqual([["coverage", "zip-bytes"]])
    expect(sent.at(0)?.url).toContain(`head_sha=${HEAD}`)
  })

  it("never sends the token to the storage host a download redirects to", async () => {
    const sent = stub(githubAnswers)
    await github().fetchCoverageArchives(HEAD)
    expect(sent.find((call) => call.url === STORAGE)?.headers).toEqual({})
    expect(JSON.stringify(sent.find((call) => call.url.includes("/artifacts/10/zip"))?.headers)).toContain("gh-secret")
  })

  it("refuses a download redirected to plain http", async () => {
    stub((url) => (url.includes("/zip") ? new Response(null, { status: 302, headers: { location: "http://storage.example.net/x" } }) : githubAnswers(url)))
    await expect(github().fetchCoverageArchives(HEAD)).rejects.toThrow("isn't https")
  })

  it("reports a token that can't read CI", async () => {
    stub(() => new Response("{}", { status: 403 }))
    await expect(github().fetchCoverageArchives(HEAD)).rejects.toMatchObject({ status: 403 })
  })

  it("downloads GitLab artifacts from jobs named for coverage in the commit's pipeline", async () => {
    stub((url) => {
      if (url.includes("/pipelines?")) return json([{ id: 5 }])
      if (url.includes("/pipelines/5/jobs")) {
        return json([
          { id: 1, name: "coverage", artifacts_file: { size: 5 } },
          { id: 2, name: "build", artifacts_file: { size: 5 } },
          { id: 3, name: "coverage-empty", artifacts_file: null },
        ])
      }
      return new Response("zip-bytes", { status: 200 })
    })
    expect((await gitlab().fetchCoverageArchives(HEAD)).map((archive) => archive.name)).toEqual(["coverage"])
  })

  it("downloads GitLab artifacts from a job that declares a coverage report, whatever its name, first", async () => {
    stub((url) => {
      if (url.includes("/pipelines?")) return json([{ id: 5 }])
      if (url.includes("/pipelines/5/jobs")) {
        return json([
          { id: 1, name: "coverage-merge", artifacts_file: { size: 5 }, artifacts: [{ file_type: "archive" }] },
          { id: 2, name: "test", artifacts_file: { size: 5 }, artifacts: [{ file_type: "archive" }, { file_type: "cobertura" }] },
          { id: 3, name: "lint", artifacts_file: { size: 5 }, artifacts: [{ file_type: "archive" }, { file_type: "junit" }] },
          // GitLab keeps a report declared without `paths` outside the archive, which is all its API serves.
          { id: 4, name: "unit", artifacts_file: null, artifacts: [{ file_type: "cobertura" }] },
        ])
      }
      return new Response("zip-bytes", { status: 200 })
    })
    expect((await gitlab().fetchCoverageArchives(HEAD)).map((archive) => archive.name)).toEqual(["test", "coverage-merge"])
  })

  it("finds nothing when GitLab has no pipeline for the commit", async () => {
    stub(() => json([]))
    expect(await gitlab().fetchCoverageArchives(HEAD)).toEqual([])
  })
})
