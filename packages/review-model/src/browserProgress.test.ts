import { describe, expect, it } from "vitest"
import { parseProgressRecord, progressKey } from "./browserProgress.ts"

describe("the saved progress record", () => {
  it("is keyed by the PR's URL", () => {
    expect(progressKey("https://github.com/acme/app/pull/7")).toBe("walkdiff-progress:https://github.com/acme/app/pull/7")
  })

  it.each([
    ['{"reviewed":3,"total":7}', { reviewed: 3, total: 7 }],
    [null, undefined],
    ["not json", undefined],
    ['{"reviewed":8,"total":7}', undefined],
    ['{"reviewed":-1,"total":7}', undefined],
  ])("reads %j", (text, expected) => {
    expect(parseProgressRecord(text)).toEqual(expected)
  })
})
