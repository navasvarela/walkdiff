import { describe, expect, it } from "vitest"
import { tokenSimilarity } from "./similarity.ts"

describe("tokenSimilarity", () => {
  it.each([
    { name: "identical sequences", a: ["a", "b", "c"], b: ["a", "b", "c"], expected: 1 },
    { name: "nothing in common", a: ["a", "b"], b: ["c", "d"], expected: 0 },
    { name: "one pair of two shared", a: ["a", "b", "c"], b: ["a", "b", "d"], expected: 0.5 },
    { name: "the same tokens in another order", a: ["a", "b", "c"], b: ["c", "b", "a"], expected: 0 },
    { name: "two empty sequences", a: [], b: [], expected: 1 },
    { name: "single equal tokens", a: ["a"], b: ["a"], expected: 1 },
    { name: "single different tokens", a: ["a"], b: ["b"], expected: 0 },
  ])("scores $name as $expected", ({ a, b, expected }) => {
    expect(tokenSimilarity(a, b)).toBe(expected)
  })

  it("counts a repeated pair only as often as both sides have it", () => {
    expect(tokenSimilarity(["x", "y", "x", "y"], ["x", "y"])).toBeCloseTo((2 * 1) / 4)
  })

  it("keeps tokens that join to the same text apart", () => {
    expect(tokenSimilarity(["a", "bc"], ["ab", "c"])).toBe(0)
  })
})
