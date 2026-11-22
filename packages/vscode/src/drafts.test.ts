import { submitReviewSchema } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { draftRange, DraftStore, reviewCommentsFrom } from "./drafts.ts"
import type { Draft, DraftStorage } from "./drafts.ts"
import { testReport } from "./testReport.ts"

const URL = "https://github.com/acme/app/pull/7"

function memoryStorage(initial: Readonly<Record<string, unknown>> = {}): DraftStorage & { readonly values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: (key) => values.get(key),
    update: async (key, value) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
  }
}

const report = testReport()
const onNewLines = draftRange(report, "src/retry.ts", "new", 1, 2)
if (onNewLines === undefined) throw new Error("fixture range")

describe("DraftStore", () => {
  it("keeps each review's drafts, edited and removed by id", async () => {
    const storage = memoryStorage()
    const store = new DraftStore(storage)
    const first = await store.add(URL, "src/retry.ts", onNewLines, "Why 5?")
    const second = await store.add(URL, "src/retry.ts", onNewLines, "And here")
    await store.edit(URL, first.id, "Why five?")
    await store.remove(URL, second.id)
    expect(store.list(URL)).toEqual([{ ...first, body: "Why five?" }])
    expect(store.list("https://github.com/acme/app/pull/8")).toEqual([])
    await store.clear(URL)
    expect(storage.values.size).toBe(0)
  })

  it("drops what it can't read back, rather than failing", () => {
    expect(new DraftStore(memoryStorage({ "walkdiff.drafts.x": [{ id: 1, text: "old shape" }] })).list("x")).toEqual([])
  })
})

describe("draftRange", () => {
  it.each([
    ["new", 1, 3, true],
    ["old", 2, 2, true],
    ["new", 3, 20, false],
    ["new", 4, 4, false],
  ] as const)("on %s lines %i to %i fits the diff: %s", (side, first, last, fits) => {
    expect(draftRange(report, "src/retry.ts", side, first, last) !== undefined).toBe(fits)
  })

  it("fits nothing in a file the PR doesn't change", () => {
    expect(draftRange(report, "README.md", "new", 1, 1)).toBeUndefined()
  })
})

describe("reviewCommentsFrom", () => {
  const draft = (overrides: Partial<Draft>): Draft => ({ id: "1", path: "src/retry.ts", range: onNewLines, body: " Why? ", ...overrides })

  it("places drafts on their lines, with a renamed file's old path", () => {
    const onRenamed = draftRange(report, "src/limits.ts", "new", 5, 5)
    if (onRenamed === undefined) throw new Error("fixture range")
    expect(reviewCommentsFrom([draft({}), draft({ id: "2", path: "src/limits.ts", range: onRenamed })], report)).toEqual([
      { path: "src/retry.ts", previousPath: "src/retry.ts", line: null, label: "src/retry.ts, lines 1–2", range: onNewLines, body: "Why?" },
      { path: "src/limits.ts", previousPath: "src/caps.ts", line: null, label: "src/limits.ts, line 5", range: onRenamed, body: "Why?" },
    ])
  })

  it("builds comments the app's submit schema takes, placed or not", () => {
    const gone = { side: "old", start: { oldLine: 30, newLine: null }, end: { oldLine: 30, newLine: null } } as const
    const comments = reviewCommentsFrom([draft({}), draft({ id: "2", range: gone })], report)
    expect(submitReviewSchema.safeParse({ event: "comment", body: "", headSha: "a".repeat(40), comments }).success).toBe(true)
  })

  it("keeps a draft whose lines left the diff, for the review's text, and skips empty ones", () => {
    const gone = { side: "new", start: { oldLine: null, newLine: 40 }, end: { oldLine: null, newLine: 41 } } as const
    expect(reviewCommentsFrom([draft({ range: gone }), draft({ id: "2", body: "  " })], report)).toEqual([{ path: "src/retry.ts", previousPath: "src/retry.ts", line: null, label: "src/retry.ts, lines 40–41", range: null, body: "Why?" }])
  })
})
