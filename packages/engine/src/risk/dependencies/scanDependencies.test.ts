import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha, Risk } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { collectFileDiffs } from "../../changedFiles.ts"
import { runGit } from "../../git.ts"
import type { TrustSources } from "./packageTrust.ts"
import { scanDependencies } from "./scanDependencies.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // Fixture commits mustn't depend on whether the person running the tests signs theirs.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

const GO_MOD_BEFORE = "module example.com/app\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n"
const GO_MOD_AFTER = `module example.com/app

go 1.22

require (
	github.com/spf13/cobra v1.8.0
	github.com/made-up/helper v1.0.0
	golang.org/x/text v0.3.7 // indirect
)
`
const POM_BEFORE = "<project>\n  <groupId>com.acme</groupId>\n  <dependencies>\n  </dependencies>\n</project>\n"
const POM_AFTER = `<project>
  <groupId>com.acme</groupId>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.9.8</version>
    </dependency>
  </dependencies>
</project>
`
const GRADLE_AFTER = 'dependencies {\n    implementation("com.squareup.okhttp3:okhttp:4.12.0")\n}\n'

const OLD_PACKAGE = { status: "published", firstPublished: new Date("2020-01-01T00:00:00Z"), license: "MIT" } as const
const TRUST: TrustSources = {
  lookUp: async (_ecosystem, name) => (name === "github.com/made-up/helper" ? { status: "missing" } : OLD_PACKAGE),
  maliciousNames: async () => new Map(),
  now: new Date("2026-11-01T00:00:00Z"),
}
// OSV knows one vulnerable version from each ecosystem.
const VULNERABLE: ReadonlyMap<string, string> = new Map([
  ["golang.org/x/text@v0.3.7", "GO-2022-1059"],
  ["com.fasterxml.jackson.core:jackson-databind@2.9.8", "GHSA-jackson"],
])

interface OsvQuery {
  readonly package: { readonly name: string }
  readonly version: string
}

const fakeOsv = vi.fn<typeof fetch>(async (url, init) => {
  if (String(url).endsWith("/querybatch")) {
    const body: unknown = JSON.parse(String(init?.body))
    const queries: readonly OsvQuery[] = typeof body === "object" && body !== null && "queries" in body && Array.isArray(body.queries) ? body.queries : []
    return Response.json({ results: queries.map((query) => ({ vulns: [VULNERABLE.get(`${query.package.name}@${query.version}`)].filter((id) => id !== undefined).map((id) => ({ id })) })) })
  }
  const id = String(url).split("/").at(-1) ?? ""
  return Response.json({ id, summary: "Known issue", database_specific: { severity: "HIGH" } })
})

describe("scanDependencies for Go and Java", () => {
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
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-dependencies-"))
    await git("init", "--quiet")
    const base = await commit({ "go.mod": GO_MOD_BEFORE, "pom.xml": POM_BEFORE, "build.gradle": "dependencies {\n}\n" })
    const head = await commit({ "go.mod": GO_MOD_AFTER, "pom.xml": POM_AFTER, "build.gradle": GRADLE_AFTER })
    vi.stubGlobal("fetch", fakeOsv)
    const scan = await scanDependencies({ repoDir, base, head, diffs: await collectFileDiffs(repoDir, base, head), network: true, runScanner: async () => undefined, trustSources: TRUST })
    vi.unstubAllGlobals()
    findings = scan.findings
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  const summary = (): string[] => findings.map((finding) => `${finding.ruleId} ${finding.location?.path ?? ""}:${finding.location?.line ?? ""}`)

  it("notes new direct dependencies where they're declared, and flags one no registry has", () => {
    expect(summary()).toEqual(
      expect.arrayContaining(["trust.missing go.mod:7", "dependency.added pom.xml:6", "dependency.added build.gradle:2"]),
    )
    expect(summary()).not.toContain("dependency.added go.mod:8")
  })

  it("checks versions new to go.mod and the pom against OSV, including indirect modules", () => {
    expect(summary()).toEqual(expect.arrayContaining(["vulnerability.GO-2022-1059 go.mod:8", "vulnerability.GHSA-jackson pom.xml:6"]))
  })
})
