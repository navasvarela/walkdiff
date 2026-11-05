import { describe, expect, it } from "vitest"
import type { ChangedFile, DiffLine, ReviewThread } from "@walkdiff/review-model"
import { commentCountsByPath, threadContext } from "./threadPlaces.ts"

const LINES: readonly DiffLine[] = [
  { kind: "context", content: "a", oldLine: 1, newLine: 1 },
  { kind: "context", content: "b", oldLine: 2, newLine: 2 },
  { kind: "removed", content: "old c", oldLine: 3 },
  { kind: "added", content: "new c", newLine: 3 },
  { kind: "context", content: "d", oldLine: 4, newLine: 4 },
  { kind: "context", content: "e", oldLine: 5, newLine: 5 },
  { kind: "context", content: "f", oldLine: 6, newLine: 6 },
]

function file(path: string, previousPath?: string): ChangedFile {
  const content = { kind: "text", hunks: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, section: "", lines: LINES }] } as const
  return {
    diff: previousPath === undefined ? { status: "modified", path, additions: 1, deletions: 1, content } : { status: "renamed", path, previousPath, similarity: 90, additions: 1, deletions: 1, content },
    noise: null,
    syntax: { status: "unsupportedLanguage" },
  }
}

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return { id: "t", path: "a.ts", line: 3, side: "new", isResolved: false, isOutdated: false, comments: [{ author: "bo", body: "Why?", createdAt: "2026", url: null }], ...overrides }
}

const contents = (lines: ReturnType<typeof threadContext>): readonly string[] | undefined => lines?.map(({ line, isCommented }) => `${isCommented ? ">" : " "}${line.content}`)

describe("threadContext", () => {
  it("shows two lines either side of a comment on a new line, marking it", () => {
    expect(contents(threadContext([file("a.ts")], thread({})))).toEqual([" b", " old c", ">new c", " d", " e"])
  })

  it("finds a comment on a removed line by its old number", () => {
    expect(contents(threadContext([file("a.ts")], thread({ line: 3, side: "old" })))).toEqual([" a", " b", ">old c", " new c", " d"])
  })

  it("stops at the edges of the hunk", () => {
    expect(contents(threadContext([file("a.ts")], thread({ line: 1 })))).toEqual([">a", " b", " old c"])
  })

  it("finds the old path of a renamed file", () => {
    expect(threadContext([file("new.ts", "old.ts")], thread({ path: "old.ts", side: "old" }))).toHaveLength(5)
  })

  it.each([
    { name: "a line outside the diff", overrides: { line: 40 } },
    { name: "outdated code", overrides: { line: null } },
    { name: "another file", overrides: { path: "b.ts" } },
  ])("has nothing for $name", ({ overrides }) => {
    expect(threadContext([file("a.ts")], thread(overrides))).toBeUndefined()
  })
})

describe("commentCountsByPath", () => {
  it("counts every comment in each file's threads, under its head path", () => {
    const reply = { author: "ana", body: "Fixed", createdAt: "2026", url: null }
    const threads = [thread({}), thread({ comments: [...thread({}).comments, reply] }), thread({ path: "old.ts", side: "old" }), thread({ path: null })]
    expect(commentCountsByPath([file("a.ts"), file("new.ts", "old.ts")], threads)).toEqual(new Map([["a.ts", 3], ["new.ts", 1]]))
  })
})
