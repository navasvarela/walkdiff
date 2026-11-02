import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runGit } from "../git.ts"
import { isIgnored, readWalkdiffConfig } from "./walkdiffConfig.ts"

const COMMITTER_ENV = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
const FORBIDS_AI = JSON.stringify({ ai: { allowed: false } })
const ALLOWS_AI = JSON.stringify({ ai: { allowed: true, providers: null } })

describe("the config file from before the rename", () => {
  let repoDir = ""
  let onlyLegacy: CommitSha
  let both: CommitSha

  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const commit = async (): Promise<CommitSha> => {
    await git("add", "--all")
    await git("commit", "--quiet", "--message", "change")
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-legacy-"))
    await git("init", "--quiet")
    await writeFile(join(repoDir, ".lens.json"), FORBIDS_AI)
    onlyLegacy = await commit()
    await writeFile(join(repoDir, ".walkdiff.json"), ALLOWS_AI)
    both = await commit()
  })
  afterAll(() => rm(repoDir, { recursive: true, force: true }))

  it("is still honoured, so a rule forbidding AI review isn't lost", async () => {
    expect((await readWalkdiffConfig(repoDir, onlyLegacy)).ai.allowed).toBe(false)
  })

  it("gives way to the new file when both exist", async () => {
    expect((await readWalkdiffConfig(repoDir, both)).ai.allowed).toBe(true)
  })

  it("names the file at fault when it's broken", async () => {
    await rm(join(repoDir, ".walkdiff.json"))
    await writeFile(join(repoDir, ".lens.json"), "not json")
    const broken = await commit()
    await expect(readWalkdiffConfig(repoDir, broken)).rejects.toThrow(".lens.json is not valid JSON")
  })

  it("can't be excluded by an ignore rule", () => {
    const config = { riskPaths: [], ignore: ["*.json"], ai: { allowed: true, providers: null }, scanners: { semgrep: { rules: [] } }, quality: { enabled: true }, coverage: { paths: [] }, dependencies: { private: [] }, feedback: { url: null } }
    expect(isIgnored(config, ".lens.json")).toBe(false)
    expect(isIgnored(config, ".walkdiff.json")).toBe(false)
    expect(isIgnored(config, "other.json")).toBe(true)
  })
})
