import { describe, expect, it } from "vitest"
import { releaseNotes, ReleaseNotesError } from "./releaseNotes.ts"

const CHANGELOG = ["# Changelog", "", "## 0.8.0", "", "- **New:** stacks.", "- **Fix:** approvals.", "", "## 0.7.2", "", "- **Old:** version flag.", ""].join("\n")

describe("releaseNotes", () => {
  it("takes the tag's section, without its heading or the next version's", () => {
    const notes = releaseNotes(CHANGELOG, "v0.8.0")
    expect(notes.startsWith("- **New:** stacks.\n- **Fix:** approvals.\n\nBuilt and published")).toBe(true)
    expect(notes).not.toContain("0.7.2")
  })

  it("reads the last section to the end of the file", () => {
    expect(releaseNotes(CHANGELOG, "v0.7.2")).toMatch(/^- \*\*Old:\*\* version flag\.\n\n/)
  })

  it("ends with how the package was built and where to read more", () => {
    const notes = releaseNotes(CHANGELOG, "v0.8.0")
    expect(notes).toContain("npm audit signatures")
    expect(notes.trimEnd().endsWith("See [SECURITY.md](SECURITY.md).")).toBe(true)
  })

  it.each([
    ["a version with no section", CHANGELOG, "v0.9.0", 'no "## 0.9.0" section'],
    ["a version whose section is empty", CHANGELOG.replace("## 0.8.0", "## 0.9.0\n\n## 0.8.0"), "v0.9.0", "is empty"],
    ["a prefix of a real version", CHANGELOG, "v0.8", 'no "## 0.8" section'],
  ])("refuses %s", (_case, changelog, tag, message) => {
    expect(() => releaseNotes(changelog, tag)).toThrow(ReleaseNotesError)
    expect(() => releaseNotes(changelog, tag)).toThrow(message)
  })
})
