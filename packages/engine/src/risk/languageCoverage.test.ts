import { describe, expect, it } from "vitest"
import { languageGaps } from "./languageCoverage.ts"

describe("languageGaps", () => {
  it("says nothing when every changed file's language is covered", () => {
    expect(languageGaps(["src/lib.rs", "cmd/main.go", "README.md"])).toEqual([])
  })

  it("names unparsed languages for both checks, and parsed languages without public API rules for that one", () => {
    expect(languageGaps(["app/main.rb", "src/A.java", "src/store.c", "include/store.h", "app/other.rb"]).map((gap) => gap.check)).toEqual([
      "Dangerous-API rules for .rb files",
      "Public API checks for .rb, .java, .c, .h files",
    ])
  })
})
