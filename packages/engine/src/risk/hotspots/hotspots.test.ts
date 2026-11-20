import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema, HistoryUnavailableError } from "@walkdiff/review-model"
import type { CommitSha, FileCommit, FileHistory, Risk } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { analyzeChangedFiles } from "../../analyzeChangedFiles.ts"
import { runGit } from "../../git.ts"
import { gitHistoryReader } from "./gitHistory.ts"
import { hotspotFinding, isFix } from "./hotspotsCheck.ts"

const BASE_DATE = new Date("2026-06-01T00:00:00Z")
const DAY_MS = 24 * 60 * 60 * 1000

function commit(subject: string, daysBefore: number, author = "dev@example.com"): FileCommit {
  return { sha: `${subject.length}${daysBefore}`.padEnd(40, "0"), subject, author, committedAt: new Date(BASE_DATE.getTime() - daysBefore * DAY_MS).toISOString() }
}

function history(commits: readonly FileCommit[], total = commits.length): FileHistory {
  return { commits, total }
}

describe("isFix", () => {
  it.each([
    ["fix: handle an empty config", true],
    ["fix(parser): stop at EOF", true],
    ["Fixes crash when the cache is cold", true],
    ["hotfix for the login loop", true],
    ["fix typo in README", false],
    ["fix(ci): pin the runner", false],
    ["fix lint", false],
    ["Revert \"fix: handle an empty config\"", false],
    ["feat: add retries", false],
    ["prefix the cache keys", false],
  ])("%s → %s", (subject, expected) => {
    expect(isFix(commit(subject, 1))).toBe(expected)
  })
})

describe("hotspotFinding", () => {
  const routine = Array.from({ length: 10 }, (_, index) => commit("refactor the reader", 30 + index))

  it("leaves a file with an ordinary history alone", () => {
    expect(hotspotFinding("src/a.ts", history([...routine, commit("fix: off by one", 40)]), BASE_DATE)).toBeUndefined()
  })

  it("flags a file that keeps needing fixes", () => {
    const fixes = Array.from({ length: 5 }, (_, index) => commit("fix: wrong total", 10 + index, `dev${index}@example.com`))
    expect(hotspotFinding("src/a.ts", history([...fixes, ...routine]), BASE_DATE)).toMatchObject({
      ruleId: "hotspot.fix-prone",
      category: "hotspot",
      severity: "low",
      title: "Often fixed: 5 of 15 changes in the past year",
      location: { path: "src/a.ts", line: null },
    })
  })

  it("flags a file that changes far more than most, and says when its counts are a floor", () => {
    const found = hotspotFinding("src/a.ts", history(routine, 42), BASE_DATE)
    expect(found?.ruleId).toBe("hotspot.churn")
    expect(found?.title).toBe("Changes often: 42 commits in the past year")
    expect(found?.detail).toContain("42 commits by at least 1 person changed it, and at least 0 of them fixed something")
  })

  it("flags a revert shortly before the PR above everything else, and not an old one", () => {
    const recent = hotspotFinding("src/a.ts", history([commit("Revert \"feat: new cache\"", 20), ...routine]), BASE_DATE)
    expect(recent?.ruleId).toBe("hotspot.recently-reverted")
    expect(recent?.detail).toContain('reverted a change 3 weeks before: "Revert "feat: new cache""')
    expect(hotspotFinding("src/a.ts", history([commit("Revert \"feat: new cache\"", 200), ...routine]), BASE_DATE)).toBeUndefined()
  })
})

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

describe("hotspots in a review", () => {
  let repoDir = ""
  let base: CommitSha = commitShaSchema.parse("0".repeat(40))
  let findings: readonly Risk[] = []

  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const commitAll = async (message: string, daysBefore: number): Promise<CommitSha> => {
    const date = new Date(Date.parse("2026-06-01T00:00:00Z") - daysBefore * DAY_MS).toISOString()
    await git("add", "--all")
    await runGit(["commit", "--quiet", "--allow-empty", "--message", message], { cwd: repoDir, env: { ...COMMITTER_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(join(repoDir, path)), { recursive: true })
    await writeFile(join(repoDir, path), text)
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-hotspots-"))
    await git("init", "--quiet")
    await write("src/billing.ts", "export const rate = 0\n")
    await write("src/quiet.ts", "export const name = \"a\"\n")
    await commitAll("feat: billing", 300)
    // billing.ts keeps getting fixed; quiet.ts changes once.
    for (let index = 1; index <= 6; index++) {
      await write("src/billing.ts", `export const rate = ${index}\n`)
      await commitAll(`fix: rounding of totals, take ${index}`, 200 - index * 10)
    }
    await write("src/quiet.ts", "export const name = \"b\"\n")
    base = await commitAll("feat: rename", 100)
    await write("src/billing.ts", "export const rate = 7\n")
    await write("src/quiet.ts", "export const name = \"c\"\n")
    const head = await commitAll("feat: new rates", 1)
    const risk = (await analyzeChangedFiles(repoDir, base, head, { network: false, runScanner: async () => undefined })).risk
    findings = risk.findings.filter((finding) => finding.category === "hotspot")
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("reads each file's commits up to the merge base from git", async () => {
    const histories = await gitHistoryReader(repoDir)({ paths: ["src/billing.ts", "src/quiet.ts", "src/gone.ts"], until: base, since: new Date(Date.parse("2026-06-01T00:00:00Z") - 365 * DAY_MS) })
    expect(histories.get("src/billing.ts")?.total).toBe(7)
    expect(histories.get("src/quiet.ts")?.commits.map((entry) => entry.subject)).toEqual(["feat: rename", "feat: billing"])
    expect(histories.get("src/gone.ts")?.total).toBe(0)
  })

  it("flags only the file that keeps needing fixes, under its own check", () => {
    expect(findings.map((finding) => `${finding.ruleId} ${finding.location?.path ?? ""} ${finding.check ?? ""}`)).toEqual(["hotspot.fix-prone src/billing.ts Hotspots"])
  })

  it("says it has no history in a shallow clone", async () => {
    const shallow = await mkdtemp(join(tmpdir(), "walkdiff-shallow-"))
    try {
      await runGit(["clone", "--quiet", "--depth=1", `file://${repoDir}`, shallow], { cwd: repoDir, env: COMMITTER_ENV })
      const head = commitShaSchema.parse((await runGit(["rev-parse", "HEAD"], { cwd: shallow })).trim())
      await expect(gitHistoryReader(shallow)({ paths: ["src/billing.ts"], until: head, since: new Date(0) })).rejects.toThrow(HistoryUnavailableError)
    } finally {
      await rm(shallow, { recursive: true, force: true })
    }
  })
})
