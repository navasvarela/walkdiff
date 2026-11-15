import { describe, expect, it } from "vitest"
import type { FileVersions } from "./compareUnits.ts"
import { extractUnits } from "./definitions.ts"
import type { FileUnits } from "./definitions.ts"
import type { LanguageSpec } from "./languageSpec.ts"
import { languageSpecFor } from "../languages/registry.ts"
import { withSyntaxTree } from "./parser.ts"
import { functionQualities } from "./functionQuality.ts"

async function units(path: string, source: string): Promise<FileUnits> {
  const spec: LanguageSpec | undefined = languageSpecFor(path)
  if (spec === undefined) throw new Error(`no language for ${path}`)
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

async function measure(path: string, before: string | undefined, after: string): Promise<ReturnType<typeof functionQualities>> {
  const file: FileVersions = { path, before: before === undefined ? undefined : await units(path, before), after: await units(path, after) }
  return functionQualities([file])
}

describe("function metrics", () => {
  it.each([
    [
      "a.ts",
      `function f(a, b) {
  if (a && b) {
    for (const x of a) {
      try {
        if (x ?? b) return 1
      } catch (e) {}
    }
  } else if (b) {
    return a ? 2 : 3
  }
  return 4
}`,
      // 1 + if + for + inner if + catch + else if + ternary + && + ??
      { complexity: 9, nesting: 4, lines: 12, parameters: 2 },
    ],
    [
      "a.py",
      `def f(self, a, b):
    if a and b:
        for x in a:
            while x or b:
                pass
    elif b:
        return 1
    return 2`,
      // 1 + if + for + while + elif + and + or
      { complexity: 7, nesting: 3, lines: 8, parameters: 2 },
    ],
    [
      "a.rs",
      `fn f(&self, a: bool, b: bool) -> i32 {
    if a && b {
        for x in 0..3 {
            match x {
                0 => return 1,
                _ => {}
            }
        }
    } else if a || b {
        return 2;
    }
    3
}`,
      // 1 + if + for + two match arms + else if + && + ||
      { complexity: 8, nesting: 3, lines: 13, parameters: 2 },
    ],
  ])("measures complexity, nesting, length and parameters in %s", async (path, source, metrics) => {
    const [fn] = await measure(path, undefined, source)
    expect(fn?.after).toEqual(metrics)
  })

  it("does not count a chain of else-ifs as nesting", async () => {
    const [fn] = await measure("a.ts", undefined, "function f(a) { if (a) {} else if (!a) {} else if (a) {} }")
    expect(fn?.after.nesting).toBe(1)
  })

  it("measures methods of a new class, which the unit comparison reports only as the class", async () => {
    const functions = await measure("a.py", "x = 1\n", "class C:\n    def m(self, a):\n        return a\n")
    expect(functions.map((fn) => [fn.qualifiedName, fn.before])).toEqual([["C.m", undefined]])
  })

  it("matches by name first, then by body, so a rename is not a new function", async () => {
    const [changed] = await measure("a.ts", "function f(a) { return a }", "function f(a) { if (a) return 1; return a }")
    expect(changed?.before?.complexity).toBe(1)
    expect(changed?.after.complexity).toBe(2)
    const [renamed] = await measure("a.ts", "function f(a) { if (a) return 1; return a }", "function g(a) { if (a) return 1; return a }")
    expect(renamed?.qualifiedName).toBe("g")
    expect(renamed?.before?.complexity).toBe(2)
  })
})
