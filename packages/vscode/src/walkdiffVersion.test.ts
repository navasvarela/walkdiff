import { describe, expect, it } from "vitest"
import { versionProblem } from "./walkdiffVersion.ts"

describe("versionProblem", () => {
  it.each(["walkdiff 0.14.0", "walkdiff 0.15.2\n", "walkdiff 1.0.0", "something else entirely", ""])("lets %j start", (output) => {
    expect(versionProblem(output)).toBeUndefined()
  })

  it.each([
    ["walkdiff 0.13.0", "runs 0.13.0"],
    ["walkdiff 0.9.12\n", "runs 0.9.12"],
  ])("says %j is too old", (output, says) => {
    expect(versionProblem(output)).toContain(says)
    expect(versionProblem(output)).toContain("needs Walkdiff 0.14.0 or later")
  })
})
