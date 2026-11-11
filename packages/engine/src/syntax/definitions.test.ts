import { describe, expect, it } from "vitest"
import { extractUnits } from "./definitions.ts"
import type { FileUnits } from "./definitions.ts"
import type { LanguageSpec } from "./languageSpec.ts"
import { withSyntaxTree } from "./parser.ts"
import { pythonSpec } from "./python.ts"
import { rustSpec } from "./rust.ts"
import { tsxSpec, typescriptSpec } from "./typescript.ts"

function unitsOf(spec: LanguageSpec, source: string): Promise<FileUnits> {
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

async function outline(spec: LanguageSpec, source: string): Promise<string[]> {
  const units = await unitsOf(spec, source)
  return units.definitions.map((definition) => `${definition.kind} ${definition.qualifiedName}`)
}

const RUST_SOURCE = `use std::fmt;

/// A size in bytes.
#[derive(Debug, Clone)]
pub struct Size(u64);

impl Size {
    pub fn new(bytes: u64) -> Self { Size(bytes) }
}

impl fmt::Display for Size {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { write!(f, "{}", self.0) }
}

trait Measure {
    fn measure(&self) -> u64;
}

mod tests {
    fn helper() { let inner = || 1; }
}

const LIMIT: u64 = 10;
`

const TYPESCRIPT_SOURCE = `import { z } from "zod"

export interface Options { readonly verbose: boolean }

export type Mode = "fast" | "slow"

export const DEFAULT_MODE: Mode = "fast"

export const parse = (input: string): number => Number(input)

export class Parser {
  readonly #options: Options
  handle = (event: Event) => {}
  parse(input: string): number { return parse(input) }
}

function helper(): void {
  const local = 1
}

describe("parse", () => {
  const fixture = "1"
  it("works", () => {})
})

namespace Shapes {
  export function area(): number { return 0 }
}
`

const PYTHON_SOURCE = `import os

CONSTANT = 1

@dataclass
class Point:
    x: int

    @property
    def norm(self) -> float:
        def inner():
            return 0
        return 0.0

def main():
    pass

if __name__ == "__main__":
    def script_only():
        pass
`

describe("extractUnits", () => {
  it("extracts Rust items, naming methods the way rustdoc does", async () => {
    expect(await outline(rustSpec, RUST_SOURCE)).toEqual([
      "struct Size",
      "impl impl Size",
      "method Size::new",
      "impl impl fmt::Display for Size",
      "method <Size as fmt::Display>::fmt",
      "trait Measure",
      "method Measure::measure",
      "module tests",
      "function tests::helper",
      "constant LIMIT",
    ])
  })

  it("extracts TypeScript declarations and tests, but not locals inside functions, calls or tests", async () => {
    expect(await outline(typescriptSpec, TYPESCRIPT_SOURCE)).toEqual([
      "interface Options",
      "typeAlias Mode",
      "constant DEFAULT_MODE",
      "function parse",
      "class Parser",
      "method Parser.handle",
      "method Parser.parse",
      "function helper",
      "testSuite parse",
      "test parse › works",
      "module Shapes",
      "function Shapes.area",
    ])
  })

  it("parses JSX through the TSX grammar", async () => {
    expect(await outline(tsxSpec, "export function App() { return <div>hi</div> }\n")).toEqual(["function App"])
  })

  it("extracts Python classes, methods and functions, not nested helpers", async () => {
    expect(await outline(pythonSpec, PYTHON_SOURCE)).toEqual([
      "class Point",
      "method Point.norm",
      "function main",
      "function script_only",
    ])
  })

  it("includes doc comments and attributes in a unit's snapshot", async () => {
    const units = await unitsOf(rustSpec, RUST_SOURCE)
    const size = units.definitions.find((definition) => definition.qualifiedName === "Size")
    expect(size?.snapshot).toEqual({
      startLine: 3,
      endLine: 5,
      text: "/// A size in bytes.\n#[derive(Debug, Clone)]\npub struct Size(u64);",
      elidesNestedUnits: false,
    })
  })

  it("includes decorators and export keywords in a unit's snapshot", async () => {
    const python = await unitsOf(pythonSpec, PYTHON_SOURCE)
    expect(python.definitions.find((definition) => definition.name === "norm")?.snapshot.text).toMatch(/^ {4}@property\n/)
    const typescript = await unitsOf(typescriptSpec, TYPESCRIPT_SOURCE)
    expect(typescript.definitions.find((definition) => definition.name === "parse")?.snapshot.text).toMatch(/^export const parse/)
  })

  it("keeps code outside top-level definitions in the module scope", async () => {
    const units = await unitsOf(pythonSpec, PYTHON_SOURCE)
    expect(units.moduleScope.snapshot.text).toBe(
      'import os\n\nCONSTANT = 1\n\nclass Point: ⋯\n\ndef main(): ⋯\n\nif __name__ == "__main__":\n    def script_only(): ⋯\n',
    )
  })

  it("collapses a container's nested units to their first line", async () => {
    const units = await unitsOf(pythonSpec, PYTHON_SOURCE)
    expect(units.definitions.at(0)?.snapshot).toEqual({
      startLine: 5,
      endLine: 13,
      text: "@dataclass\nclass Point:\n    x: int\n\n    def norm(self) -> float: ⋯",
      elidesNestedUnits: true,
    })
  })
})

describe("fingerprints", () => {
  async function fingerprintsOf(spec: LanguageSpec, source: string) {
    const units = await unitsOf(spec, source)
    const first = units.definitions.at(0)
    if (first === undefined) throw new Error("expected a definition")
    return first.fingerprints
  }

  it("ignores whitespace, quote style and trailing commas", async () => {
    const before = await fingerprintsOf(typescriptSpec, "function f(a, b) { return g('x', [a, b]) }")
    const after = await fingerprintsOf(typescriptSpec, 'function f(\n  a,\n  b,\n) {\n  return g("x", [a, b,])\n}')
    expect(after.full).toBe(before.full)
  })

  it("separates comment changes from code changes", async () => {
    const before = await fingerprintsOf(rustSpec, "fn f() {\n    // old\n    let a = 1;\n}")
    const commented = await fingerprintsOf(rustSpec, "fn f() {\n    // new\n    let a = 1;\n}")
    const changed = await fingerprintsOf(rustSpec, "fn f() {\n    // old\n    let a = 2;\n}")
    expect(commented.code).toBe(before.code)
    expect(commented.full).not.toBe(before.full)
    expect(changed.code).not.toBe(before.code)
  })

  it("masks the unit's name for rename detection", async () => {
    const before = await fingerprintsOf(pythonSpec, "def old(x):\n    return old(x - 1)")
    const after = await fingerprintsOf(pythonSpec, "def new(x):\n    return old(x - 1)")
    expect(after.nameAgnosticCode).toBe(before.nameAgnosticCode)
    expect(after.code).not.toBe(before.code)
  })

  it("leaves nested units out of a container's own fingerprint", async () => {
    const units = await unitsOf(pythonSpec, "class A:\n    def m(self):\n        return 1\n")
    const changed = await unitsOf(pythonSpec, "class A:\n    def m(self):\n        return 2\n")
    expect(changed.definitions.at(0)?.fingerprints.ownFull).toBe(units.definitions.at(0)?.fingerprints.ownFull)
    expect(changed.definitions.at(1)?.fingerprints.code).not.toBe(units.definitions.at(1)?.fingerprints.code)
  })
})

describe("test callbacks", () => {
  const TESTS = `import { describe, it } from "vitest"

beforeAll(async () => { await start() })

describe("parser", () => {
  const input = "x"
  beforeEach(() => reset())

  function fixture(): string { return input }

  it("reads includes", () => { expect(parse(fixture())).toBe(1) })

  describe.each([1, 2])("with %i workers", (workers) => {
    test.only(\`runs \${workers} at once\`, async () => {})
  })

  it.skipIf(slow)("skips when slow", function () {})
  it.todo("isn't written yet")
})

test.describe("Playwright", () => {
  test("opens the page", async ({ page }) => {})
})

describe("same title", () => {})
describe("same title", () => {})
`

  it("makes each suite, test and hook a unit, nested under its suite", async () => {
    expect(await outline(typescriptSpec, TESTS)).toEqual([
      "testHook beforeAll",
      "testSuite parser",
      "testHook parser › beforeEach",
      "function parser › fixture",
      "test parser › reads includes",
      "testSuite parser › with %i workers",
      "test parser › with %i workers › runs ${workers} at once",
      "test parser › skips when slow",
      "testSuite Playwright",
      "test Playwright › opens the page",
      "testSuite same title",
      "testSuite same title",
    ])
  })

  it("keeps two suites with one title apart", async () => {
    const units = await unitsOf(typescriptSpec, TESTS)
    const keys = units.definitions.filter((definition) => definition.name === "same title").map((definition) => definition.key)
    expect(new Set(keys).size).toBe(2)
  })

  it("leaves a suite's locals and a test without a callback in the suite's own code", async () => {
    const units = await unitsOf(typescriptSpec, TESTS)
    const parser = units.definitions.find((definition) => definition.qualifiedName === "parser")
    expect(parser?.snapshot.text).toContain('const input = "x"')
    expect(parser?.snapshot.text).toContain('it.todo("isn\'t written yet")')
    expect(parser?.snapshot.text).toContain('it("reads includes", () => { expect(parse(fixture())).toBe(1) }) ⋯')
  })

  it("leaves imports and calls that aren't tests in the module scope", async () => {
    const units = await unitsOf(typescriptSpec, 'import { x } from "y"\nsetup(() => {})\nobj.describe("not a suite", () => {})\n')
    expect(units.definitions).toEqual([])
    expect(units.moduleScope.hasOwnTokens).toBe(true)
  })

  it("doesn't count tests as public API", async () => {
    const units = await unitsOf(typescriptSpec, 'export { parse }\ndescribe("parse", () => { it("works", () => {}) })\n')
    expect(units.definitions.map((definition) => definition.isPublic)).toEqual([false, false])
  })

  it("treats a retitled test with the same body as a rename", async () => {
    const before = await unitsOf(typescriptSpec, 'it("reads includes", () => { expect(1).toBe(1) })\n')
    const after = await unitsOf(typescriptSpec, 'it("reads every include", () => { expect(1).toBe(1) })\n')
    expect(after.definitions.at(0)?.fingerprints.nameAgnosticCode).toBe(before.definitions.at(0)?.fingerprints.nameAgnosticCode)
    expect(after.definitions.at(0)?.fingerprints.code).not.toBe(before.definitions.at(0)?.fingerprints.code)
  })
})
