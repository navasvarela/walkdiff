import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitShaSchema, REVIEW_MODEL_SCHEMA_VERSION } from "@walkdiff/review-model"
import type { ChangedFile, HostedReviewModel, Risk } from "@walkdiff/review-model"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { parseCommandLine, UsageError } from "./args.ts"
import { detectPullRequestUrl } from "./ciEnvironment.ts"
import { runComment } from "./commentCommand.ts"
import { diffLink, escapeMarkdown, renderSummaryComment, SUMMARY_COMMENT_MARKER } from "./summaryComment.ts"

const SHA = commitShaSchema.parse("a".repeat(40))

function modelWith(url: string, overrides: Partial<HostedReviewModel> = {}): HostedReviewModel {
  const file: ChangedFile = {
    diff: { status: "modified", path: "src/a.py", additions: 1, deletions: 1, content: { kind: "text", hunks: [] } },
    noise: null,
    syntax: {
      status: "analyzed",
      language: "python",
      outline: [],
      calls: [],
      units: [
        {
          kind: "function",
          name: "parse",
          qualifiedName: "parse",
          facts: null,
          change: {
            kind: "modified",
            weight: "semantic",
            before: { startLine: 1, endLine: 1, text: "a", elidesNestedUnits: false },
            after: { startLine: 1, endLine: 1, text: "b", elidesNestedUnits: false },
          },
          impact: {
            status: "traced",
            searchedName: "parse",
            totalReferences: 1,
            references: [{ path: "src/b.py", line: 2, callerQualifiedName: "run", confidence: "likely", touchedByPullRequest: false, snippet: "parse(x)" }],
          },
        },
      ],
    },
  }
  return {
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: "2026-10-30T00:00:00Z",
    pullRequest: {
      host: "github",
      url,
      repositoryWebUrl: "https://github.com/acme/app",
      number: 7,
      title: "t",
      description: "",
      author: "dev",
      baseRef: "main",
      headRef: "x",
      baseSha: SHA,
      headSha: SHA,
      mergeBaseSha: SHA,
    },
    files: [file],
    risk: {
      securityLevel: "medium",
      findings: [
        { ruleId: "rust.unsafe", category: "dangerousApi", severity: "medium", title: "unsafe code", detail: "d", location: { path: "a.rs", line: 1 }, evidence: null },
        { ruleId: "rust.unsafe", category: "dangerousApi", severity: "medium", title: "unsafe code", detail: "d", location: { path: "b.rs", line: 2 }, evidence: null },
        { ruleId: "dependency.added", category: "dependency", severity: "low", title: "New dependency: @evil/pkg [x](http://bad)", detail: "d", location: { path: "package.json", line: 1 }, evidence: null },
      ],
      checksRun: [],
      notChecked: [{ check: "c", reason: "r" }],
    },
    ai: { status: "disabled" },
    testCoverage: null,
    feedbackUrl: "https://forms.example.com/walkdiff",
    ...overrides,
  }
}

describe("renderSummaryComment", () => {
  const body = renderSummaryComment(modelWith("https://github.com/acme/app/pull/7"), "https://example.com/report")

  it("summarizes level, counts, grouped findings, the link and how to give feedback", () => {
    expect(body.startsWith(SUMMARY_COMMENT_MARKER)).toBe(true)
    expect(body).toContain("3 security findings")
    expect(body).toContain("isn't a security audit")
    expect(body).not.toContain("security level")
    expect(body).toContain("| **Changes** | **1** code unit to review |")
    expect(body).toContain("| **Used elsewhere** | **1** place this PR did not touch uses code it changed |")
    expect(body).toMatch(/\| 🟠 Medium \| unsafe code \| \[`a\.rs:\d+`\]\(\S+\) and 1 more \|/)
    expect(body).toContain("[Open the full report](https://example.com/report)")
    expect(body).toContain("⚠️ **1 did not run**")
    expect(body).toContain("[leave feedback](https://forms.example.com/walkdiff)")
  })

  it("neutralizes names from the PR", () => {
    expect(body).not.toContain("[x](http://bad)")
    expect(body).not.toContain("@evil")
    expect(escapeMarkdown("a\n# b `c` <img>")).toBe("a #​ b \\`c\\` \\<img\\>")
  })
})

describe("the comment's wording and links", () => {
  const finding = (title: string, category: Risk["category"], severity: Risk["severity"] = "low"): Risk => ({ ruleId: "r", category, severity, title, detail: "d", location: { path: "src/a|b.ts", line: 3 }, evidence: null })
  const model = (findings: readonly Risk[], host: "github" | "gitlab" = "github"): HostedReviewModel => {
    const base = modelWith("https://github.com/acme/app/pull/7")
    return { ...base, pullRequest: { ...base.pullRequest, host }, risk: { ...base.risk, findings: [...findings], checksRun: [{ name: "Semgrep", detail: "d" }, { name: "oxlint", detail: "d" }], notChecked: [] } }
  }
  const URL = "https://example.com/r"

  it.each([
    ["nothing found", [], "> [!NOTE]", "**No security findings** from `Semgrep`."],
    ["a medium finding", [finding("x", "codeScan", "medium")], "> [!WARNING]", "**1 security finding**"],
    ["a high finding", [finding("x", "secret", "high")], "> [!CAUTION]", "**1 security finding**"],
    ["only non-security findings", [finding("x", "codeQuality", "high")], "> [!NOTE]", "**No security findings**"],
  ] as const)("calls out %s without grading the change", (_name, findings, alert, summary) => {
    const body = renderSummaryComment(model(findings), URL)
    expect(body).toContain(alert)
    expect(body).toContain(summary)
    expect(body).not.toMatch(/security level/i)
  })

  it("leaves out the alert marker on GitLab, where older versions show it as text", () => {
    expect(renderSummaryComment(model([], "gitlab"), URL)).not.toContain("[!")
  })

  it("shows marked names in code font, and keeps a table together despite a pipe", () => {
    const body = renderSummaryComment(model([finding("`run|all` was removed but `x` remains", "brokenReference")]), URL)
    expect(body).toContain("`run\\|all` was removed but `x` remains")
    expect(body).toContain("[`src/a\\|b.ts:3`]")
  })

  it("orders the table most severe first", () => {
    const body = renderSummaryComment(model([finding("low one", "codeQuality", "low"), finding("high one", "secret", "high")]), URL)
    expect(body.indexOf("high one")).toBeLessThan(body.indexOf("low one"))
  })

  it("can't be made to link, ping or break out by a crafted name in or out of code", () => {
    const crafted = finding("`[x](http://bad)` @evil [y](http://bad) ![z](http://bad) <img src=x> | cell", "dependency")
    const body = renderSummaryComment(model([crafted]), URL)
    expect(body).not.toContain("[y](http://bad)")
    expect(body).not.toContain("![z]")
    expect(body).not.toContain("<img src=x>")
    expect(body).not.toContain("@evil")
    expect(body).toContain("`[x](http://bad)`")
  })

  it.each([
    ["github", "src/a.ts", 3, "https://h/o/r/pull/1/files#diff-96e3ba9b4f9a2c5d06ed42f1ca0dc4b90bad3f4aa2d4d2ccd8ad71a39f4e0f48R3"],
    ["github", "src/a.ts", null, "https://h/o/r/pull/1/files#diff-96e3ba9b4f9a2c5d06ed42f1ca0dc4b90bad3f4aa2d4d2ccd8ad71a39f4e0f48"],
  ] as const)("links %s findings into the PR's diff (%s:%s)", (host, path, line, expected) => {
    const pullRequest = { ...modelWith("https://h/o/r/pull/1").pullRequest, host }
    const hash = createHash("sha256").update(path).digest("hex")
    expect(diffLink(pullRequest, path, line)).toBe(expected.replace(/diff-[0-9a-f]+/, `diff-${hash}`))
  })

  it("links GitLab findings to the file, which is as close as a new line number can reach", () => {
    const pullRequest = { ...modelWith("https://gl/o/r/-/merge_requests/1").pullRequest, host: "gitlab" as const }
    expect(diffLink(pullRequest, "src/a.ts", 3)).toBe(`https://gl/o/r/-/merge_requests/1/diffs#${createHash("sha1").update("src/a.ts").digest("hex")}`)
  })
})

describe("detectPullRequestUrl", () => {
  let dir = ""

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "walkdiff-ci-"))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads the PR from the GitHub Actions event", async () => {
    const path = join(dir, "event.json")
    await writeFile(path, JSON.stringify({ pull_request: { html_url: "https://github.com/acme/app/pull/7" } }))
    expect(await detectPullRequestUrl({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path })).toBe("https://github.com/acme/app/pull/7")
  })

  it("explains when a GitHub run is not for a PR", async () => {
    const path = join(dir, "push.json")
    await writeFile(path, JSON.stringify({ ref: "refs/heads/main" }))
    await expect(detectPullRequestUrl({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path })).rejects.toThrow(UsageError)
  })

  it("builds the merge request URL in GitLab CI, nested groups included", async () => {
    const env = { GITLAB_CI: "true", CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.com/g/sub/app", CI_MERGE_REQUEST_IID: "9" }
    expect(await detectPullRequestUrl(env)).toBe("https://gitlab.com/g/sub/app/-/merge_requests/9")
  })

  it("asks for a URL outside CI", async () => {
    await expect(detectPullRequestUrl({})).rejects.toThrow(UsageError)
  })
})

describe("parseCommandLine", () => {
  it("accepts review without a URL and requires both comment options", () => {
    expect(parseCommandLine(["review", "--no-serve"], {}).command).toMatchObject({ kind: "review", options: { url: undefined, serve: false } })
    expect(() => parseCommandLine(["comment", "--report", "r"], {}).command).toThrow(UsageError)
    expect(() => parseCommandLine(["comment", "--report", "r", "--report-url", "javascript:alert(1)"], {}).command).toThrow(UsageError)
  })

  it("reads --local with or without a base", () => {
    expect(parseCommandLine(["review", "--local"], {}).command).toMatchObject({ kind: "review", options: { url: undefined, local: { baseRef: undefined } } })
    expect(parseCommandLine(["review", "--local", "--base", "develop"], {}).command).toMatchObject({ kind: "review", options: { local: { baseRef: "develop" } } })
    expect(parseCommandLine(["review", "https://github.com/acme/app/pull/7"], {}).command).toMatchObject({ kind: "review", options: { local: undefined } })
  })

  it.each([
    [["review", "--local", "https://github.com/acme/app/pull/7"], "takes no pull request URL"],
    [["review", "--base", "main"], "--base only applies with --local"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseCommandLine(argv, {}).command).toThrow(message)
  })

  it("accepts setup on its own", () => {
    expect(parseCommandLine(["setup"], {}).command).toEqual({ kind: "setup" })
    expect(() => parseCommandLine(["setup", "extra"], {}).command).toThrow(UsageError)
  })

  it.each([
    [[], {}, "text"],
    [["--log-format", "json"], {}, "json"],
    [[], { WALKDIFF_LOG_FORMAT: "json" }, "json"],
    [["--log-format", "text"], { WALKDIFF_LOG_FORMAT: "json" }, "text"],
  ])("reads the log format from %j and %j as %s", (flags, env, format) => {
    expect(parseCommandLine(["review", ...flags], env).logFormat).toBe(format)
  })

  it.each([
    [["--log-format", "xml"], {}, "--log-format must be text or json"],
    [[], { WALKDIFF_LOG_FORMAT: "yaml" }, "WALKDIFF_LOG_FORMAT must be text or json"],
  ])("refuses an unknown log format", (flags, env, message) => {
    expect(() => parseCommandLine(["review", ...flags], env)).toThrow(message)
  })
})

/** Runs the real provider and fetch against a local stand-in for each host's API. */
describe("runComment against stand-in host APIs", () => {
  interface RecordedCall {
    readonly method: string
    readonly path: string
    readonly body: unknown
  }
  let calls: RecordedCall[] = []
  let existingComments: unknown[] = []
  let updateStatus = 200
  let createStatus = 201
  let origin = ""
  let reportDir = ""
  const logs: string[] = []

  const server = createServer((request, response) => {
    let text = ""
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")))
    request.on("end", () => {
      const method = request.method ?? ""
      const path = request.url ?? ""
      calls.push({ method, path, body: text === "" ? null : JSON.parse(text) })
      const status = method === "PATCH" || method === "PUT" ? updateStatus : method === "POST" ? createStatus : 200
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(method === "GET" ? existingComments : { id: 1 }))
    })
  })
  const writes = (): RecordedCall[] => calls.filter((call) => call.method !== "GET")

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    origin = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : ""
    reportDir = await mkdtemp(join(tmpdir(), "walkdiff-comment-"))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(reportDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    calls = []
    existingComments = []
    updateStatus = 200
    createStatus = 201
    logs.length = 0
  })

  const run = async (pullRequestUrl: string, stepSummaryPath?: string): Promise<void> => {
    await writeFile(join(reportDir, "review.json"), JSON.stringify(modelWith(pullRequestUrl)))
    await runComment(
      { reportDir, reportUrl: "https://example.com/report" },
      { tokens: { github: "gh-token", gitlab: "gl-token", trustedOrigins: { github: [], gitlab: [] } }, stepSummaryPath, log: (message) => logs.push(message) },
    )
  }

  it("creates a GitHub comment when none exists, under Enterprise API paths", async () => {
    await run(`${origin}/acme/app/pull/7`)
    expect(writes()).toMatchObject([{ method: "POST", path: "/api/v3/repos/acme/app/issues/7/comments" }])
  })

  it("updates the earlier comment instead of adding another", async () => {
    existingComments = [{ id: 5, body: "unrelated" }, { id: 6, body: `${SUMMARY_COMMENT_MARKER}\nold` }]
    await run(`${origin}/acme/app/pull/7`)
    expect(writes()).toMatchObject([{ method: "PATCH", path: "/api/v3/repos/acme/app/issues/comments/6" }])
  })

  it("posts a new comment when the marked one belongs to someone else", async () => {
    existingComments = [{ id: 6, body: SUMMARY_COMMENT_MARKER }]
    updateStatus = 403
    await run(`${origin}/acme/app/pull/7`)
    expect(writes().map((call) => call.method)).toEqual(["PATCH", "POST"])
  })

  it("uses GitLab's notes API", async () => {
    existingComments = [{ id: 8, body: SUMMARY_COMMENT_MARKER }]
    await run(`${origin}/g/sub/app/-/merge_requests/9`)
    expect(writes()).toMatchObject([{ method: "PUT", path: "/api/v4/projects/g%2Fsub%2Fapp/merge_requests/9/notes/8" }])
  })

  it("warns rather than fails on a read-only token, and still writes the job summary", async () => {
    const summary = join(reportDir, "summary.md")
    await writeFile(summary, "")
    createStatus = 403
    await run(`${origin}/acme/app/pull/7`, summary)
    expect(logs.join("\n")).toContain("Could not post the summary comment")
    expect(await readFile(summary, "utf8")).toContain("Walkdiff")
  })
})
