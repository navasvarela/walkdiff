import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { CommitSha, Risk } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { analyzeChangedFiles } from "../../analyzeChangedFiles.ts"
import { runGit } from "../../git.ts"
import { documentedParameters } from "./parameterDocs.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

describe("documentedParameters", () => {
  it.each([
    ["JSDoc", "/**\n * Sends it.\n * @param {string} url Where to.\n * @param [retries] How often.\n */\nfunction send(url, retries) {}", ["url", "retries"]],
    ["Javadoc and KDoc", "/**\n * @param path the file\n * @return its size\n */", ["path"]],
    ["reST", 'def load(path, strict):\n    """Load it.\n\n    :param path: the file\n    :param bool strict: fail on unknown keys\n    """', ["path", "strict"]],
    [
      "Google style",
      'def load(path, strict=False, **options):\n    """Load it.\n\n    Args:\n        path (str): The file. Relative paths\n            resolve from: the current folder.\n        strict: Fail on unknown keys.\n        **options: Passed on.\n\n    Returns:\n        result: the config.\n    """',
      ["path", "strict", "options"],
    ],
    ["NumPy style", 'def load(path, strict):\n    """Load it.\n\n    Parameters\n    ----------\n    path : str\n        The file: relative or absolute.\n    strict : bool\n\n    Returns\n    -------\n    dict\n    """', ["path", "strict"]],
    ["Rust", "/// Reads it.\n///\n/// # Arguments\n///\n/// * `path` - the file\n/// * `mode` - how to open it\nfn read(path: &str, mode: Mode) {}", ["path", "mode"]],
  ])("reads %s", (_style, text, expected) => {
    expect([...documentedParameters(text)].sort()).toEqual([...expected].sort())
  })
})

describe("docs drift", () => {
  let repoDir = ""
  let findings: readonly Risk[] = []

  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(repoDir, path)), { recursive: true })
    await writeFile(join(repoDir, path), content)
  }
  const commit = async (): Promise<CommitSha> => {
    await git("add", "--all")
    await git("commit", "--quiet", "--message", "change")
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-docs-drift-"))
    await git("init", "--quiet")
    await write(
      "README.md",
      [
        "# Tool",
        "",
        "Run `tool --log-format json` for JSON logs, or `tool --quiet`.",
        "Preview with `tool --dry-run`.",
        "Call `parseSettings()` from your own code.",
        "`parseSettings` was renamed to `loadSettings` in 2.0.",
        "",
      ].join("\n"),
    )
    await write("CHANGELOG.md", "- Added `--log-format`.\n")
    await write(
      "src/cli.ts",
      [
        'const FLAGS = ["--log-format", "--quiet", "--verbose"]',
        "const HELP = `",
        "  --dry-run   Show what would change",
        "`",
        "",
        "export function parseSettings(path: string): string[] {",
        "  const text = path.trim()",
        '  return text.split("\\n").filter((line) => line.length > 0)',
        "}",
        "",
        "/**",
        " * Reads the settings file.",
        " * @param path Where it is.",
        " * @param strict Fail on unknown keys.",
        " */",
        "export function readSettings(path: string, strict: boolean): string {",
        "  return strict ? path : path.trim()",
        "}",
        "",
      ].join("\n"),
    )
    // A test the PR forgot still uses --dry-run, which doesn't keep the option alive.
    await write("tests/cli.test.ts", 'it("previews", () => run(["--dry-run"]))\n')
    const base = await commit()

    // Drops --log-format and --verbose, which the docs keep only for --log-format; renames
    // parseSettings; swaps readSettings' `strict` parameter for `encoding`.
    await write(
      "src/cli.ts",
      [
        'const FLAGS = ["--quiet"]',
        "const HELP = ``",
        "",
        "export function loadSettings(path: string): string[] {",
        "  const text = path.trim()",
        '  return text.split("\\n").filter((line) => line.length > 0)',
        "}",
        "",
        "/**",
        " * Reads the settings file.",
        " * @param path Where it is.",
        " * @param strict Fail on unknown keys.",
        " */",
        "export function readSettings(path: string, encoding: string): string {",
        '  return encoding === "utf8" ? path : path.trim()',
        "}",
        "",
      ].join("\n"),
    )
    const head = await commit()
    const risk = (await analyzeChangedFiles(repoDir, base, head, { network: false, runScanner: async () => undefined })).risk
    findings = risk.findings.filter((finding) => finding.category === "docsDrift")
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  const summary = (): string[] => findings.map((finding) => `${finding.ruleId} ${finding.severity} ${finding.location?.path ?? ""}:${finding.location?.line ?? "-"} ${finding.title}`).sort()

  it("flags docs that still use a removed option, quoted or in usage text, or a renamed function, but not the changelog or a line describing the rename", () => {
    expect(summary()).toEqual(
      [
        "docs.stale-flag medium README.md:3 Docs still mention `--log-format`",
        "docs.stale-flag medium README.md:4 Docs still mention `--dry-run`",
        "docs.stale-name low README.md:5 Docs still mention `parseSettings`",
        "docs.parameters low src/cli.ts:9 Doc comment of `readSettings` doesn't match its parameters",
      ].sort(),
    )
  })

  it("says what replaced a renamed name and what the doc comment gets wrong", () => {
    const byRule = new Map(findings.map((finding) => [finding.ruleId, finding.detail]))
    expect(byRule.get("docs.stale-name")).toContain("renames it to `loadSettings`")
    expect(byRule.get("docs.parameters")).toBe("It still describes `strict`, which it no longer takes, and doesn't describe `encoding`. Editors and generated docs show this text to everyone who calls it.")
  })

  it("is reported as a dimension of its own, under a check of its own", () => {
    expect(findings.every((finding) => finding.check === "Docs drift")).toBe(true)
  })
})
