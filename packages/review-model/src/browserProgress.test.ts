import { describe, expect, it } from "vitest"
import { parseProgressRecord, progressKey } from "./browserProgress.ts"

const HEAD = { headSha: "a".repeat(40), baseRef: "main" }
const saved = (record: object): string => JSON.stringify({ head: HEAD, ...record })

describe("the saved progress record", () => {
  it("is keyed by the PR's URL", () => {
    expect(progressKey("https://github.com/acme/app/pull/7")).toBe("walkdiff-progress:https://github.com/acme/app/pull/7")
  })

  it.each([
    [saved({ reviewed: 3, total: 7, drafts: 2 }), { reviewed: 3, total: 7, drafts: 2, head: HEAD }],
    // Without the report it counted on, the list couldn't tell whether it is out of date.
    ['{"reviewed":3,"total":7,"drafts":0}', undefined],
    [null, undefined],
    ["not json", undefined],
    [saved({ reviewed: 8, total: 7, drafts: 0 }), undefined],
    [saved({ reviewed: -1, total: 7, drafts: 0 }), undefined],
  ])("reads %j", (text, expected) => {
    expect(parseProgressRecord(text)).toEqual(expected)
  })
})
