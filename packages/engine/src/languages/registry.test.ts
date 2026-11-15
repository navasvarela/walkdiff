import { SourceLanguage } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { canReferenceAcross, LANGUAGES, languageFor, namesOfLanguages, SUPPORTED_EXTENSIONS } from "./registry.ts"

describe("the language registry", () => {
  it("gives every extension to exactly one language", () => {
    const extensions = LANGUAGES.flatMap((language) => language.extensions)
    expect(new Set(extensions).size).toBe(extensions.length)
    expect(SUPPORTED_EXTENSIONS).toHaveLength(extensions.length)
    expect(extensions.every((extension) => extension.startsWith(".") && extension === extension.toLowerCase())).toBe(true)
  })

  it("gives every language its own parser", () => {
    expect(new Set(LANGUAGES.map((language) => language.spec.language)).size).toBe(LANGUAGES.length)
  })

  it.each([
    ["src/lib.rs", SourceLanguage.Rust],
    ["web/App.JSX", SourceLanguage.Tsx],
    ["include/vec.h", SourceLanguage.Cpp],
    ["build.gradle.kts", SourceLanguage.Kotlin],
  ])("reads %s as %s", (path, language) => {
    expect(languageFor(path)?.spec.language).toBe(language)
  })

  it("leaves files it can't parse alone", () => {
    expect(languageFor("Gemfile.rb")).toBeUndefined()
    expect(languageFor("Makefile")).toBeUndefined()
  })

  it("lets a family's languages refer to each other, and no one else", () => {
    expect(canReferenceAcross(SourceLanguage.TypeScript, SourceLanguage.Tsx)).toBe(true)
    expect(canReferenceAcross(SourceLanguage.C, SourceLanguage.Cpp)).toBe(true)
    expect(canReferenceAcross(SourceLanguage.Java, SourceLanguage.Kotlin)).toBe(false)
    expect(canReferenceAcross(SourceLanguage.Go, SourceLanguage.Go)).toBe(true)
  })

  it("names the languages a check covers once each, in order", () => {
    expect(namesOfLanguages((language) => language.librarySurface !== undefined)).toBe("Rust, TypeScript/JavaScript, Python and Go")
    expect(namesOfLanguages((language) => language.routes.length > 0)).toBe("Rust, TypeScript/JavaScript, Python, Go, Java, Kotlin and C#")
  })
})
