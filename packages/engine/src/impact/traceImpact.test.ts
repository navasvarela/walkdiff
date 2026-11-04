import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, CommitSha } from "@walkdiff/review-model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { analyzeChangedFiles } from "../analyzeChangedFiles.ts"
import { runGit } from "../git.ts"
import { containerTypeName, simpleTypeName } from "./traceImpact.ts"

const CONVERT_BODY = "    if rate <= 0:\n        raise ValueError(\"rate must be positive\")\n    value = amount * rate\n    return round(value, 2)\n"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

describe("traceImpact", () => {
  let repoDir = ""
  let files: ChangedFile[] = []

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
  const unit = (path: string, qualifiedName: string): ChangedUnit | undefined => {
    const syntax = files.find((file) => file.diff.path === path)?.syntax
    return syntax?.status === "analyzed" ? syntax.units.find((candidate) => candidate.qualifiedName === qualifiedName) : undefined
  }
  const referencesOf = (path: string, qualifiedName: string): string[] => {
    const impact = unit(path, qualifiedName)?.impact
    if (impact?.status !== "traced") return []
    return impact.references.map(
      (reference) =>
        `${reference.path}:${reference.line} ${reference.callerQualifiedName ?? "-"} ${reference.confidence}${reference.touchedByPullRequest ? " touched" : ""}`,
    )
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-impact-"))
    await git("init", "--quiet")
    await write(
      "src/size.rs",
      [
        "pub struct Size(u64);",
        "impl Size {",
        "    pub fn bytes(&self) -> u64 { self.0 }",
        "    pub fn kib(&self) -> u64 { self.bytes() / 1024 }",
        "}",
        "",
      ].join("\n"),
    )
    await write(
      "src/report.rs",
      [
        "// bytes are shown in the report",
        "fn show(s: &Size) -> u64 { s.bytes() }",
        "fn total(a: &Size) -> u64 { Size::bytes(a) }",
        "fn other(x: &Other) -> u64 { Other::bytes(x) }",
        "",
      ].join("\n"),
    )
    await write("py/utils.py", "def parse(text):\n    return int(text)\n\ndef keep():\n    pass\n")
    await write("py/app.py", "from utils import parse\n\ndef run(raw):\n    return parse(raw)\n")
    await write("web/format.ts", "export function oldName(x: number) {\n  return x * 2\n}\n")
    await write("web/caller.ts", 'import { oldName } from "./format"\nexport const twice = (x: number) => oldName(x)\n')
    await write("web/stale.ts", 'import { oldName } from "./format"\nexport function legacy() {\n  return oldName(1)\n}\n')
    await write("py/money.py", `def convert(amount, rate):\n${CONVERT_BODY}\n\ndef keep_money():\n    pass\n`)
    await write("py/shop.py", "from money import convert\n\ndef checkout(total):\n    return convert(total, 1.2)\n")
    const base = await commit()

    await write(
      "src/size.rs",
      [
        "pub struct Size(u64);",
        "impl Size {",
        "    pub fn bytes(&self) -> u64 { self.0 * 1 }",
        "    pub fn kib(&self) -> u64 { self.bytes() / 1024 }",
        "}",
        "",
      ].join("\n"),
    )
    await write("py/utils.py", "def keep():\n    pass\n")
    await write("web/format.ts", "export function newName(x: number) {\n  return x * 2\n}\n")
    await write("web/caller.ts", 'import { newName } from "./format"\nexport const twice = (x: number) => newName(x * 1)\n')
    await write("py/money.py", "def keep_money():\n    pass\n")
    await write("py/fx.py", `def convert(amount, rate):\n${CONVERT_BODY.replace("round(value, 2)", "round(value, 4)")}`)
    const head = await commit()

    files = (await analyzeChangedFiles(repoDir, base, head, { network: false, runScanner: async () => undefined })).files
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("finds method callers by path, self and unknown receiver, excluding other types' methods and comments", () => {
    expect(referencesOf("src/size.rs", "Size::bytes")).toEqual([
      "src/report.rs:3 total exact",
      "src/size.rs:4 Size::kib exact",
      "src/report.rs:2 show possible",
    ])
  })

  it("reports where a removed function is still used", () => {
    expect(referencesOf("py/utils.py", "parse")).toEqual(["py/app.py:1 - likely", "py/app.py:4 run likely"])
  })

  it("searches the old name of a renamed unit and flags callers the PR did not update", () => {
    const renamed = unit("web/format.ts", "newName")
    expect(renamed?.impact).toMatchObject({ status: "traced", searchedName: "oldName" })
    expect(referencesOf("web/format.ts", "newName")).toEqual(["web/stale.ts:1 - likely", "web/stale.ts:3 legacy likely"])
  })

  it("traces callers of a function moved and edited, where it arrived", () => {
    expect(unit("py/fx.py", "convert")).toMatchObject({ change: { kind: "movedIn", edited: true }, impact: { status: "traced", searchedName: "convert" } })
    expect(referencesOf("py/fx.py", "convert")).toEqual(["py/shop.py:1 - likely", "py/shop.py:4 checkout likely"])
    expect(unit("py/money.py", "convert")?.impact).toBeNull()
  })

  it("does not trace changes that cannot affect callers", () => {
    expect(unit("web/caller.ts", "twice")?.impact).toMatchObject({ status: "traced" })
    expect(unit("web/caller.ts", "(module scope)")?.impact).toBeNull()
  })
})

describe("simpleTypeName", () => {
  it.each([
    ["Size", "Size"],
    ["<Size as fmt::Display>", "Size"],
    ["crate::units::Size<T>", "Size"],
    ["Shapes.Circle", "Circle"],
  ])("reduces %s to %s", (path, expected) => {
    expect(simpleTypeName(path)).toBe(expected)
  })

  it("finds a method's container from its qualified name", () => {
    expect(containerTypeName("<Size as fmt::Display>::fmt", "::")).toBe("Size")
    expect(containerTypeName("Parser.parse", ".")).toBe("Parser")
    expect(containerTypeName("parse", ".")).toBeUndefined()
  })
})

describe("traceImpact with names defined more than once", () => {
  let repoDir = ""
  let files: ChangedFile[] = []

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
  const referencesOf = (path: string, qualifiedName: string): string[] => {
    const syntax = files.find((file) => file.diff.path === path)?.syntax
    const impact = syntax?.status === "analyzed" ? syntax.units.find((unit) => unit.qualifiedName === qualifiedName)?.impact : undefined
    return impact?.status === "traced" ? impact.references.map((reference) => `${reference.path}:${reference.line} ${reference.confidence}`) : []
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "walkdiff-ambiguous-"))
    await git("init", "--quiet")
    await write("core/intrinsics.rs", "pub fn abort() -> ! { loop {} }\n")
    await write("core/walk.rs", "pub fn scan() -> u32 { 1 }\n")
    await write("example/mini_core.rs", "fn abort() -> ! { loop {} }\nfn main() { abort() }\n")
    await write("codegen/backend.rs", "fn lower() { emit(sym::abort); abort(); }\nfn go() { walk::scan(); other::scan(); }\n")
    const base = await commit()
    await write("core/intrinsics.rs", "\n")
    await write("core/walk.rs", "pub fn scan() -> u32 { 2 }\n")
    const head = await commit()
    files = (await analyzeChangedFiles(repoDir, base, head, { network: false, runScanner: async () => undefined })).files
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it("ignores uses in a file with its own definition and downgrades the rest to possible", () => {
    expect(referencesOf("core/intrinsics.rs", "abort")).toEqual(["codegen/backend.rs:1 possible", "codegen/backend.rs:1 possible"])
  })

  it("treats a path as likely only when it names the defining module", () => {
    expect(referencesOf("core/walk.rs", "scan")).toEqual(["codegen/backend.rs:2 likely", "codegen/backend.rs:2 possible"])
  })
})
