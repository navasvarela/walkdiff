import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha, Risk } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { collectFileDiffs } from "../../changedFiles.ts"
import { runGit } from "../../git.ts"
import { classifyNoise } from "../../noise.ts"
import type { NpmRelease, ReleaseLookup } from "./npmReleases.ts"
import { scanSupplyChain } from "./scanSupplyChain.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

function packageLock(packages: Readonly<Record<string, object>>): string {
  return `${JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } }, null, 2)}\n`
}

// A scoped package's tarball is named without its scope: `@acme/core/-/core-2.0.0.tgz`.
const tarball = (name: string, version: string): string => `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1) ?? name}-${version}.tgz`

const LOCK_BEFORE = packageLock({
  "node_modules/left-pad": { version: "1.3.0", resolved: tarball("left-pad", "1.3.0"), integrity: "sha512-original" },
  "node_modules/ua-parser-js": { version: "0.7.28", resolved: tarball("ua-parser-js", "0.7.28"), integrity: "sha512-a" },
})
const LOCK_AFTER = packageLock({
  "node_modules/left-pad": { version: "1.3.0", resolved: tarball("left-pad", "1.3.0"), integrity: "sha512-tampered" },
  "node_modules/ua-parser-js": { version: "0.7.29", resolved: tarball("ua-parser-js", "0.7.29"), integrity: "sha512-b", hasInstallScript: true },
  "node_modules/@acme/core": { version: "2.0.0", resolved: tarball("@acme/core", "2.0.0"), integrity: "sha512-c" },
})

const BY_MAINTAINER: NpmRelease = { publisher: "faisalman", maintainers: new Set(["faisalman"]), hasProvenance: false, trustedPublisher: false }
const releases: Readonly<Record<string, NpmRelease>> = {
  "ua-parser-js@0.7.28": BY_MAINTAINER,
  "ua-parser-js@0.7.29": { ...BY_MAINTAINER, publisher: "someone-else" },
}
const lookUpRelease: ReleaseLookup = async (name, version) => releases[`${name}@${version}`]

describe("scanSupplyChain", () => {
  let repoDir = ""
  let findings: readonly Risk[] = []

  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const commit = async (files: Readonly<Record<string, string>>): Promise<CommitSha> => {
    for (const [path, text] of Object.entries(files)) await writeFile(join(repoDir, path), text)
    await git("add", "--all")
    await git("commit", "--quiet", "--message", "change")
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-supply-chain-"))
    await git("init", "--quiet")
    const base = await commit({ "package-lock.json": LOCK_BEFORE, ".npmrc": "save-exact=true\n" })
    const after: Readonly<Record<string, string>> = { "package-lock.json": LOCK_AFTER, ".npmrc": "save-exact=true\nstrict-ssl=false\n" }
    const head = await commit(after)
    const diffs = await collectFileDiffs(repoDir, base, head)
    const files = diffs.map((diff) => ({ diff, noise: classifyNoise(diff.path, after[diff.path]), after: after[diff.path] }))
    const scan = await scanSupplyChain({ repoDir, base, head, files, privatePackages: ["@acme/*"], network: true, disabled: new Set(), lookUpRelease })
    findings = scan.findings
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("reads the lockfile at both commits and the settings the PR adds", () => {
    const summary = findings.map((finding) => `${finding.ruleId} ${finding.location?.path ?? ""}:${finding.location?.line ?? ""}`)
    expect(summary).toEqual([
      "supply-chain.tls-off .npmrc:2",
      "supply-chain.integrity-changed package-lock.json:8",
      "supply-chain.install-script-added package-lock.json:13",
      "supply-chain.dependency-confusion package-lock.json:19",
      "supply-chain.new-publisher package-lock.json:13",
    ])
  })
})
