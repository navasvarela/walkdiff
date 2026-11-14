import { describe, expect, it } from "vitest"
import { bumpPins, checkNextVersion, ReleasePreparationError } from "./prepareRelease.ts"

describe("bumpPins", () => {
  it.each([
    ["uses: navasvarela/walkdiff@v0.10.0", "uses: navasvarela/walkdiff@v0.10.1"],
    ['default: "walkdiff@0.10.0"', 'default: "walkdiff@0.10.1"'],
    ["https://raw.githubusercontent.com/navasvarela/walkdiff/v0.10.0/ci/gitlab-ci.yml", "https://raw.githubusercontent.com/navasvarela/walkdiff/v0.10.1/ci/gitlab-ci.yml"],
    ["Status: early release, [v0.10.0](CHANGELOG.md).", "Status: early release, [v0.10.1](CHANGELOG.md)."],
  ])("moves %s", (text, expected) => {
    expect(bumpPins(text, "0.10.0", "0.10.1")).toBe(expected)
  })

  it.each([
    ["a longer version", "v0.10.0.1"],
    ["a version that only starts the same", "v0.10.01"],
    ["a version inside another", "v10.10.0"],
    ["a different package", "other@0.10.0"],
    ["a version without its prefix", "pnpm@0.10.0 and 0.10.0"],
  ])("leaves %s alone", (_case, text) => {
    expect(bumpPins(text, "0.10.0", "0.10.1")).toBe(text)
  })
})

describe("checkNextVersion", () => {
  it.each([
    ["0.10.0", "0.10.1"],
    ["0.10.0", "0.11.0"],
    ["0.10.0", "1.0.0"],
    ["0.9.9", "0.10.0"],
  ])("accepts %s → %s", (current, next) => {
    expect(() => checkNextVersion(current, next)).not.toThrow()
  })

  it.each([
    ["0.10.0", "0.10.0", "isn't above"],
    ["0.10.0", "0.9.9", "isn't above"],
    ["0.10.0", "v0.10.1", "isn't a version"],
    ["0.10.0", "0.10", "isn't a version"],
  ])("refuses %s → %s", (current, next, message) => {
    expect(() => checkNextVersion(current, next)).toThrow(ReleasePreparationError)
    expect(() => checkNextVersion(current, next)).toThrow(message)
  })
})
