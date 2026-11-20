import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha, Risk } from "@walkdiff/review-model"
import { afterAll, describe, expect, it } from "vitest"
import { analyzeChangedFiles } from "../../analyzeChangedFiles.ts"
import { runGit } from "../../git.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

type Files = Readonly<Record<string, string>>

const repositories: string[] = []

/** The scope findings for a PR that turns `base` into `head`. */
async function scopeFindings(base: Files, head: Files): Promise<Risk[]> {
  const repoDir = await mkdtemp(join(tmpdir(), "walkdiff-scope-"))
  repositories.push(repoDir)
  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const commit = async (files: Files): Promise<CommitSha> => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repoDir, path)), { recursive: true })
      await writeFile(join(repoDir, path), text)
    }
    await git("add", "--all")
    await git("commit", "--quiet", "--allow-empty", "--message", "change")
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }
  await git("init", "--quiet")
  const from = await commit(base)
  const to = await commit(head)
  const { risk } = await analyzeChangedFiles(repoDir, from, to, { network: false, runScanner: async () => undefined })
  return risk.findings.filter((finding) => finding.category === "scope")
}

afterAll(async () => {
  await Promise.all(repositories.map((repoDir) => rm(repoDir, { recursive: true, force: true })))
})

function helper(name: string, body: string): string {
  return `export function ${name}(value: number): number {\n${body}\n}\n`
}

const HELPERS: Files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`src/helpers/h${index}.ts`, helper(`scaleBy${index}`, `  return value * ${index}`)]))
const REFORMATTED: Files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`src/helpers/h${index}.ts`, helper(`scaleBy${index}`, `    return value  *  ${index}`)]))

function lockfile(version: (index: number) => string): string {
  const packages = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`node_modules/dep-${index}`, { version: version(index), resolved: `https://registry.npmjs.org/dep-${index}/-/dep-${index}-${version(index)}.tgz`, integrity: `sha512-${index}${version(index)}` }]))
  return `${JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } }, null, 2)}\n`
}

describe("scope", () => {
  it("flags a tidy-up and bulk upgrades riding along with a behaviour change", async () => {
    const base = { ...HELPERS, "src/total.ts": helper("totalWithTax", "  return value * 1.2"), "package-lock.json": lockfile(() => "1.0.0") }
    const head = { ...REFORMATTED, "src/total.ts": helper("totalWithTax", "  return Math.round(value * 1.21)"), "package-lock.json": lockfile(() => "1.1.0") }
    const findings = await scopeFindings(base, head)
    expect(findings.map((finding) => `${finding.ruleId} ${finding.title}`)).toEqual(["scope.mixed-concerns Mixes a tidy-up and upgrades with behaviour changes"])
    expect(findings[0]?.detail).toContain("5 files that are only reformatted, re-commented, renamed or moved (`src/helpers/h0.ts`, `src/helpers/h1.ts`, `src/helpers/h2.ts` and 2 more), and 10 package upgrades in `package-lock.json`")
    expect(findings[0]?.check).toBe("Scope")
  })

  const PACKAGES: Files = {
    "packages/billing/package.json": '{ "name": "@acme/billing" }\n',
    "packages/search/package.json": '{ "name": "@acme/search" }\n',
    "packages/billing/src/rates.ts": "export const base = 1\n",
    "packages/search/src/query.ts": "export const limit = 10\n",
  }
  const billing = "export const base = 1\n" + helper("invoiceTotal", "  return value") + helper("invoiceTaxes", "  return value") + helper("invoiceDiscount", "  return value")

  it("flags behaviour changes in packages that don't use each other", async () => {
    const search = "export const limit = 10\n" + helper("rankMatches", "  return value") + helper("boostRecent", "  return value") + helper("dropStale", "  return value")
    const findings = await scopeFindings(PACKAGES, { "packages/billing/src/rates.ts": billing, "packages/search/src/query.ts": search })
    expect(findings.map((finding) => `${finding.ruleId} ${finding.title}`)).toEqual(["scope.unrelated-areas Changes 2 packages that don't use each other"])
    expect(findings[0]?.detail).toContain("Behaviour changes in `packages/billing`; `packages/search`")
  })

  it("leaves packages alone when one uses what the other adds", async () => {
    const search = "import { invoiceTotal } from \"@acme/billing\"\nexport const limit = 10\n" + helper("rankMatches", "  return invoiceTotal(value)") + helper("boostRecent", "  return value") + helper("dropStale", "  return value")
    expect(await scopeFindings(PACKAGES, { "packages/billing/src/rates.ts": billing, "packages/search/src/query.ts": search })).toEqual([])
  })

  it("leaves packages alone when one declares a dependency on the other, as layers of one feature do", async () => {
    const search = "export const limit = 10\n" + helper("rankMatches", "  return value") + helper("boostRecent", "  return value") + helper("dropStale", "  return value")
    const declared = { ...PACKAGES, "packages/search/package.json": '{ "name": "@acme/search", "dependencies": { "@acme/billing": "workspace:*" } }\n' }
    expect(await scopeFindings(declared, { "packages/billing/src/rates.ts": billing, "packages/search/src/query.ts": search })).toEqual([])
  })

  it("leaves a focused change alone, tests and docs included", async () => {
    const base = { ...HELPERS, "src/total.ts": helper("totalWithTax", "  return value * 1.2") }
    const head = { "src/total.ts": helper("totalWithTax", "  return value * 1.21"), "src/total.test.ts": "it(\"adds tax\", () => {})\n", "README.md": "Tax is 21%.\n" }
    expect(await scopeFindings(base, head)).toEqual([])
  })
})
