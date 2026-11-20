import { describe, expect, it } from "vitest"
import { MajorTagError, majorTagToMove } from "./majorTag.ts"

describe("majorTagToMove", () => {
  it.each<[string, string[], string | undefined]>([
    ["v0.13.0", ["v0.12.0", "v0.13.0", "v0"], "v0"],
    ["v1.0.0", ["v0.13.0", "v1.0.0"], "v1"],
    ["v0.12.1", ["v0.12.1", "v0.13.0"], undefined],
    ["v0.13.0", ["v0.13.0", "v1.0.0", "v1"], "v0"],
    ["v0.9.0", ["v0.10.0"], undefined],
    ["v0.13.0", ["v0.13.0-rc.1", "latest", "v0"], "v0"],
  ])("moves the tag for %s given %j → %s", (tag, existing, expected) => {
    expect(majorTagToMove(tag, existing)).toBe(expected)
  })

  it("refuses a tag that isn't a release", () => {
    expect(() => majorTagToMove("v0", [])).toThrow(MajorTagError)
    expect(() => majorTagToMove("0.13.0", [])).toThrow(MajorTagError)
  })
})
