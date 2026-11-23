import { describe, expect, it } from "vitest"
import { isAllowedRequest } from "./reportRequests.ts"

describe("isAllowedRequest", () => {
  it.each([
    ["GET", "/api/reviews"],
    ["GET", "/api/reviews/4/conversation"],
    ["POST", "/api/reviews/4/submit"],
    ["POST", "/api/reviews/4/threads/PRRT_1/reply"],
    ["POST", "/api/reviews/4/threads/PRRT_1/resolve"],
  ] as const)("passes on %s %s for review 4", (method, path) => {
    expect(isAllowedRequest(4, method, path)).toBe(true)
  })

  it.each([
    ["GET", "/api/reviews/5/conversation", "another review's"],
    ["POST", "/api/reviews/5/submit", "posting to another review"],
    ["POST", "/api/reviews", "adding a review"],
    ["GET", "/api/settings", "the settings"],
    ["POST", "/api/reviews/4/refresh", "a refresh"],
    ["POST", "/api/reviews/4/threads//reply", "a thread without an id"],
    ["POST", "/api/reviews/4/threads/a/b/reply", "a nested path"],
    ["GET", "/api/reviews/4/submit", "a GET of an action"],
    ["POST", "/api/reviews/40/submit", "a longer id"],
  ] as const)("refuses %s %s, %s", (method, path, _what) => {
    expect(isAllowedRequest(4, method, path)).toBe(false)
  })
})
