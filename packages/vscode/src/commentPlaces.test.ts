import type { ReviewThread } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { commentableBlocks, fileShownAt, threadPlace } from "./commentPlaces.ts"
import { testReport } from "./testReport.ts"

const report = testReport()

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return { id: "t1", path: "src/retry.ts", line: 2, side: "new", isResolved: false, isOutdated: false, comments: [], ...overrides }
}

describe("commentableBlocks", () => {
  it("gives each side's lines in the diff as runs, split where hunks are", () => {
    const retry = fileShownAt(report, "head", "src/retry.ts")
    if (retry === undefined) throw new Error("fixture file")
    expect(commentableBlocks(retry, "head")).toEqual([
      { first: 1, last: 3 },
      { first: 20, last: 20 },
    ])
    expect(commentableBlocks(retry, "base")).toEqual([{ first: 1, last: 3 }])
  })
})

describe("fileShownAt", () => {
  it("finds a renamed file by its old path on the base side only", () => {
    expect(fileShownAt(report, "base", "src/caps.ts")?.path).toBe("src/limits.ts")
    expect(fileShownAt(report, "head", "src/caps.ts")).toBeUndefined()
  })
})

describe("threadPlace", () => {
  it("puts a thread on a new line in the head document, and on an old line in the base one", () => {
    expect(threadPlace(thread({}), report)).toEqual({ path: "src/retry.ts", documentPath: "src/retry.ts", side: "head", line: 2 })
    expect(threadPlace(thread({ path: "src/limits.ts", side: "old", line: 4 }), report)).toEqual({ path: "src/limits.ts", documentPath: "src/caps.ts", side: "base", line: 4 })
  })

  it("has no place for a thread on no line, or on a file the PR doesn't change", () => {
    expect(threadPlace(thread({ line: null }), report)).toBeUndefined()
    expect(threadPlace(thread({ path: null }), report)).toBeUndefined()
    expect(threadPlace(thread({ path: "README.md" }), report)).toBeUndefined()
  })
})
