import type { ComparedUnit } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { compareUnits } from "./compareUnits.ts"
import { extractUnits } from "./definitions.ts"
import type { FileUnits } from "./definitions.ts"
import { withSyntaxTree } from "./parser.ts"
import { pythonSpec } from "./python.ts"
import { rustSpec } from "./rust.ts"
import { typescriptSpec } from "./typescript.ts"
import type { LanguageSpec } from "./languageSpec.ts"

async function unitsOf(spec: LanguageSpec, source: string | undefined): Promise<FileUnits | undefined> {
  if (source === undefined) return undefined
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

interface FileChange {
  readonly path: string
  readonly before: string | undefined
  readonly after: string | undefined
}

async function compare(spec: LanguageSpec, changes: readonly FileChange[]): Promise<Map<string, ComparedUnit[]>> {
  const files = await Promise.all(
    changes.map(async (change) => ({
      path: change.path,
      before: await unitsOf(spec, change.before),
      after: await unitsOf(spec, change.after),
    })),
  )
  return compareUnits(files)
}

/** `kind name: change[/weight]`, the shape a reviewer would scan for. */
function summarize(units: readonly ComparedUnit[] | undefined): string[] {
  return (units ?? []).map((unit) => {
    const weight = unit.change.kind === "modified" ? `/${unit.change.weight}` : ""
    return `${unit.kind} ${unit.qualifiedName}: ${unit.change.kind}${weight}`
  })
}

const LONG_BODY = "    let total = items.iter().map(|item| item.price * item.quantity).sum::<u64>();\n    total + shipping(total)\n"

describe("compareUnits", () => {
  it("reports only the method that changed, not its class", async () => {
    const result = await compare(pythonSpec, [
      {
        path: "a.py",
        before: "class A:\n    def keep(self):\n        return 1\n\n    def change(self):\n        return 1\n",
        after: "class A:\n    def keep(self):\n        return 1\n\n    def change(self):\n        return 2\n",
      },
    ])
    expect(summarize(result.get("a.py"))).toEqual(["method A.change: modified/semantic"])
  })

  it("weighs formatting-only and comment-only edits", async () => {
    const result = await compare(rustSpec, [
      {
        path: "lib.rs",
        before: "fn spaced(a: u8) -> u8 { a }\n\nfn commented() {\n    // old\n}\n",
        after: "fn spaced(a: u8) -> u8 {\n    a\n}\n\nfn commented() {\n    // new\n}\n",
      },
    ])
    expect(summarize(result.get("lib.rs"))).toEqual([
      "function spaced: modified/formattingOnly",
      "function commented: modified/commentsOnly",
    ])
  })

  it("ignores reordering and blank lines between members", async () => {
    const result = await compare(typescriptSpec, [
      {
        path: "a.ts",
        before: "export function a() { return 1 }\nexport function b() { return 2 }\n",
        after: "export function b() { return 2 }\n\n\nexport function a() { return 1 }\n",
      },
    ])
    expect(summarize(result.get("a.ts"))).toEqual([])
  })

  it("reports a new class once, not once per method", async () => {
    const result = await compare(pythonSpec, [
      { path: "a.py", before: "import os\n", after: "import os\n\nclass New:\n    def m(self):\n        pass\n" },
    ])
    expect(summarize(result.get("a.py"))).toEqual(["class New: added"])
  })

  it("shows a new class or suite whole, since its methods or tests have no cards of their own", async () => {
    const result = await compare(typescriptSpec, [
      { path: "a.test.ts", before: "", after: 'describe("parser", () => {\n  it("reads", () => {\n    expect(read()).toBe(1)\n  })\n})\n' },
    ])
    expect(summarize(result.get("a.test.ts"))).toEqual(["testSuite parser: added"])
    expect(result.get("a.test.ts")?.at(0)?.change).toMatchObject({ after: { elidesNestedUnits: false, text: expect.stringContaining("expect(read()).toBe(1)") } })
  })

  it("lists a test added to an existing suite on its own, with the suite's other tests collapsed", async () => {
    const before = 'describe("parser", () => {\n  it("reads", () => {})\n})\n'
    const after = 'describe("parser", () => {\n  it("reads", () => {})\n  it("writes", () => {})\n})\n'
    const result = await compare(typescriptSpec, [{ path: "a.test.ts", before, after }])
    expect(summarize(result.get("a.test.ts"))).toEqual(["test parser › writes: added"])
  })

  it("detects a rename with an unchanged body", async () => {
    const result = await compare(typescriptSpec, [
      {
        path: "a.ts",
        before: "export function oldName(x: number) { return x * 2 }\n",
        after: "export function newName(x: number) { return x * 2 }\n",
      },
    ])
    const units = result.get("a.ts") ?? []
    expect(summarize(units)).toEqual(["function newName: renamed"])
    expect(units.at(0)?.change).toMatchObject({ previousName: "oldName" })
  })

  it("detects a function moved to another file", async () => {
    const result = await compare(rustSpec, [
      { path: "old.rs", before: `use x;\n\nfn total(items: &[Item]) -> u64 {\n${LONG_BODY}}\n`, after: "use x;\n" },
      { path: "new.rs", before: undefined, after: `fn total(items: &[Item]) -> u64 {\n${LONG_BODY}}\n` },
    ])
    expect(summarize(result.get("old.rs"))).toEqual(["function total: movedOut"])
    expect(summarize(result.get("new.rs"))).toEqual(["function total: movedIn"])
    expect(result.get("new.rs")?.at(0)?.change).toMatchObject({ from: { path: "old.rs", qualifiedName: "total" } })
  })

  describe("moves with edits", () => {
    const PRICE = `fn total(items: &[Item]) -> u64 {\n${LONG_BODY}}\n`
    const PRICE_WITH_FIX = "fn total(items: &[Item]) -> u64 {\n    let total = items.iter().map(|item| item.price * item.quantity).sum::<u64>();\n    total + shipping(total, region())\n}\n"

    it("detects a function moved to another file and edited on the way", async () => {
      const result = await compare(rustSpec, [
        { path: "old.rs", before: `use x;\n\n${PRICE}`, after: "use x;\n" },
        { path: "new.rs", before: undefined, after: PRICE_WITH_FIX },
      ])
      expect(summarize(result.get("old.rs"))).toEqual(["function total: movedOut"])
      expect(summarize(result.get("new.rs"))).toEqual(["function total: movedIn"])
      const arrived = result.get("new.rs")?.at(0)
      expect(arrived?.change).toMatchObject({ edited: true, from: { path: "old.rs", qualifiedName: "total" } })
      expect(arrived?.facts).toMatchObject({ callsAdded: ["region"] })
      expect(result.get("old.rs")?.at(0)?.change).toMatchObject({ edited: true, to: { path: "new.rs" } })
    })

    it("marks a move with only formatting changes as unedited", async () => {
      const result = await compare(rustSpec, [
        { path: "old.rs", before: PRICE, after: "" },
        { path: "new.rs", before: undefined, after: PRICE.replace("    total + shipping(total)", "    total +\n        shipping(total)") },
      ])
      expect(result.get("new.rs")?.at(0)?.change).toMatchObject({ kind: "movedIn", edited: false })
    })

    it.each([
      { language: "TypeScript", spec: typescriptSpec, path: "ts", before: "function toRisks(findings: readonly Finding[], files: readonly File[]): Risk[] {\n  return findings.filter((finding) => files.some((file) => file.path === finding.path)).map(toRisk)\n}\n", visible: "export function" },
      { language: "Rust", spec: rustSpec, path: "rs", before: PRICE, visible: "pub(crate) fn" },
    ])("treats a $language function exported on its way to a new module as unedited", async ({ spec, path, before, visible }) => {
      const result = await compare(spec, [
        { path: `old.${path}`, before, after: "" },
        { path: `new.${path}`, before: undefined, after: before.replace(/^function|^fn/, visible) },
      ])
      expect(result.get(`new.${path}`)?.at(0)?.change).toMatchObject({ kind: "movedIn", edited: false })
    })

    it("detects a method moved between classes of one file and edited", async () => {
      const body = "        rows = self.store.fetch(query, limit=limit)\n        return [self.decode(row) for row in rows if row is not None]\n"
      const result = await compare(pythonSpec, [
        {
          path: "a.py",
          before: `class Reader:\n    def open(self):\n        return 1\n\n    def load(self, query, limit):\n${body}\n\nclass Writer:\n    def open(self):\n        return 2\n`,
          after: `class Reader:\n    def open(self):\n        return 1\n\n\nclass Writer:\n    def open(self):\n        return 2\n\n    def load(self, query, limit):\n${body.replace("limit=limit", "limit=limit, strict=True")}`,
        },
      ])
      expect(summarize(result.get("a.py"))).toEqual(["method Reader.load: movedOut", "method Writer.load: movedIn"])
    })

    it("keeps unrelated functions that share a name apart", async () => {
      const result = await compare(typescriptSpec, [
        { path: "csv.ts", before: "export function parse(text: string): string[][] {\n  return text.split(\"\\n\").map((line) => line.split(\",\"))\n}\n", after: "" },
        { path: "url.ts", before: undefined, after: "export function parse(input: string): URL | undefined {\n  try {\n    return new URL(input)\n  } catch {\n    return undefined\n  }\n}\n" },
      ])
      expect(summarize(result.get("csv.ts"))).toEqual(["function parse: removed"])
      expect(summarize(result.get("url.ts"))).toEqual(["function parse: added"])
    })

    it("pairs each arrival with the most alike of several same-named functions", async () => {
      const result = await compare(rustSpec, [
        { path: "a.rs", before: "fn total(values: &[u64]) -> u64 {\n    values.iter().copied().filter(|value| *value > 0).sum::<u64>() + 0\n}\n", after: "" },
        { path: "b.rs", before: PRICE, after: "" },
        { path: "c.rs", before: undefined, after: PRICE_WITH_FIX },
      ])
      expect(result.get("c.rs")?.at(0)?.change).toMatchObject({ kind: "movedIn", edited: true, from: { path: "b.rs" } })
      expect(summarize(result.get("a.rs"))).toEqual(["function total: removed"])
    })

    it("still reports a rewrite under the same name elsewhere as removed and added", async () => {
      const rewrite = "fn total(items: &[Item]) -> u64 {\n    let mut sum = 0;\n    for item in items {\n        if item.active { sum += item.price; }\n    }\n    sum\n}\n"
      const result = await compare(rustSpec, [
        { path: "old.rs", before: PRICE, after: "" },
        { path: "new.rs", before: undefined, after: rewrite },
      ])
      expect(summarize(result.get("old.rs"))).toEqual(["function total: removed"])
      expect(summarize(result.get("new.rs"))).toEqual(["function total: added"])
    })
  })

  it("does not call tiny identical bodies a move", async () => {
    const result = await compare(rustSpec, [
      { path: "a.rs", before: "fn f() {}\n", after: "" },
      { path: "b.rs", before: "", after: "fn f() {}\n" },
    ])
    expect(summarize(result.get("a.rs"))).toEqual(["function f: removed"])
    expect(summarize(result.get("b.rs"))).toEqual(["function f: added"])
  })

  it("reports import changes as a module scope change", async () => {
    const result = await compare(pythonSpec, [
      { path: "a.py", before: "import os\n\ndef f():\n    pass\n", after: "import os\nimport sys\n\ndef f():\n    pass\n" },
    ])
    expect(summarize(result.get("a.py"))).toEqual(["moduleScope (module scope): modified/semantic"])
  })

  it("treats every unit of a new file as added, with no module scope when there is none", async () => {
    const result = await compare(pythonSpec, [{ path: "new.py", before: undefined, after: "def a():\n    pass\n\ndef b():\n    pass\n" }])
    expect(summarize(result.get("new.py"))).toEqual(["function a: added", "function b: added"])
  })
})
