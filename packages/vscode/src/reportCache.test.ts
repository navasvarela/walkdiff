import type { ReviewModel } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { draftKeyOf, ReportCache } from "./reportCache.ts"
import { testReport } from "./testReport.ts"

function counting(load: (id: number) => Promise<ReviewModel> = async () => testReport()): { readonly cache: ReportCache; readonly loads: number[] } {
  const loads: number[] = []
  return {
    loads,
    cache: new ReportCache(async (id) => {
      loads.push(id)
      return load(id)
    }),
  }
}

describe("ReportCache", () => {
  it("reads a report once per version of its review", async () => {
    const { cache, loads } = counting()
    await cache.current({ id: 1, updatedAt: "v1" })
    await cache.current({ id: 1, updatedAt: "v1" })
    await cache.latest(1)
    await cache.current({ id: 1, updatedAt: "v2" })
    expect(loads).toEqual([1, 1])
  })

  it("reads again after a failure", async () => {
    let fail = true
    const { cache, loads } = counting(async () => {
      if (fail) throw new Error("app stopped")
      return testReport()
    })
    await expect(cache.latest(3)).rejects.toThrow("app stopped")
    fail = false
    await expect(cache.latest(3)).resolves.toBeDefined()
    expect(loads).toEqual([3, 3])
  })
})

describe("draftKeyOf", () => {
  it("keys drafts by the PR's link", () => {
    expect(draftKeyOf(testReport(), 1)).toBe("https://github.com/acme/app/pull/7")
  })
})
