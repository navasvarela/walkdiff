import { describe, expect, it } from "vitest"
import { commentableLines, describeRange, previousPathOf, rangeBetween, reviewCommentOnLines } from "./diffLines.ts"
import type { FileDiff } from "./schema.ts"

// Old lines 1-4 and new lines 1-4, with old line 2 replaced by new line 2, then a gap, then new line 20.
const DIFF: FileDiff = {
  status: "renamed",
  path: "src/a.ts",
  previousPath: "src/old.ts",
  similarity: 90,
  additions: 2,
  deletions: 1,
  content: {
    kind: "text",
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        section: "",
        lines: [
          { kind: "context", content: "a", oldLine: 1, newLine: 1 },
          { kind: "removed", content: "b", oldLine: 2 },
          { kind: "added", content: "B", newLine: 2 },
          { kind: "context", content: "c", oldLine: 3, newLine: 3 },
        ],
      },
      { oldStart: 19, oldLines: 0, newStart: 20, newLines: 1, section: "", lines: [{ kind: "added", content: "z", newLine: 20 }] },
    ],
  },
}
const lines = commentableLines(DIFF)

describe("commentableLines", () => {
  it("knows each line in the diff by both numbers where it has them", () => {
    expect([...lines.new.keys()]).toEqual([1, 2, 3, 20])
    expect([...lines.old.keys()]).toEqual([1, 2, 3])
    expect(lines.new.get(3)).toEqual({ oldLine: 3, newLine: 3 })
    expect(lines.new.get(2)).toEqual({ oldLine: null, newLine: 2 })
  })
})

describe("rangeBetween", () => {
  it.each([
    ["new", 1, 3, "lines 1–3"],
    ["new", 3, 1, "lines 1–3"],
    ["new", 20, 20, "line 20"],
    ["old", 2, 2, "line 2 (before)"],
  ] as const)("picks %s lines %s to %s", (side, from, to, described) => {
    const range = rangeBetween(lines, side, from, to)
    expect(range === undefined ? undefined : describeRange(range)).toBe(described)
  })

  it.each([
    ["new", 3, 20],
    ["new", 4, 4],
    ["old", 1, 4],
  ] as const)("refuses %s lines %s to %s, which aren't all in the diff", (side, from, to) => {
    expect(rangeBetween(lines, side, from, to)).toBeUndefined()
  })
})

describe("reviewCommentOnLines", () => {
  it("posts with the file's old path, for a renamed file, and names the lines", () => {
    const range = rangeBetween(lines, "new", 1, 2)
    if (range === undefined) throw new Error("fixture range")
    expect(previousPathOf(DIFF)).toBe("src/old.ts")
    expect(reviewCommentOnLines({ path: DIFF.path, previousPath: previousPathOf(DIFF) }, range, "Check")).toEqual({ path: "src/a.ts", previousPath: "src/old.ts", line: null, label: "src/a.ts, lines 1–2", range, body: "Check" })
  })
})
