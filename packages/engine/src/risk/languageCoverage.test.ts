import { describe, expect, it } from "vitest"
import { languageGaps } from "./languageCoverage.ts"

describe("languageGaps", () => {
  it("says nothing when every changed file's language is covered", () => {
    expect(languageGaps(["src/lib.rs", "cmd/main.go", "README.md"])).toEqual([])
  })

  it("names unparsed languages for both checks, and parsed languages without public API rules for that one", () => {
    expect(languageGaps(["app/Main.kt", "src/A.java", "src/store.c", "include/store.h", "app/Other.kt"]).map((gap) => gap.check)).toEqual([
      "Dangerous-API rules for .kt files",
      "Public API checks for .kt, .java, .c, .h files",
    ])
  })
})
