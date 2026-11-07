import { describe, expect, it } from "vitest"
import { progressLabel } from "./progress.ts"

describe("the progress label", () => {
  it.each([
    [undefined, "not started"],
    [{ reviewed: 0, total: 5 }, "not started"],
    [{ reviewed: 2, total: 5 }, "2 of 5 reviewed"],
    [{ reviewed: 5, total: 5 }, "✓ reviewed"],
    [{ reviewed: 0, total: 0 }, "nothing to mark as reviewed"],
  ])("reads %j", (progress, label) => {
    expect(progressLabel(progress)).toBe(label)
  })
})
