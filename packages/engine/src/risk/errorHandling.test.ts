import type { DiffLine, FileDiff, Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { scanErrorHandling } from "./errorHandling.ts"
import type { ScannedFile } from "./scannedFile.ts"

/** The file at head, where lines marked with a leading `+` are the ones the PR adds. */
function changedFile(path: string, marked: string): ScannedFile {
  const lines = marked.split("\n")
  const diffLines = lines.map((line, index): DiffLine =>
    line.startsWith("+") ? { kind: "added", content: line.slice(1), newLine: index + 1 } : { kind: "context", content: line, oldLine: index + 1, newLine: index + 1 },
  )
  const diff: FileDiff = {
    status: "modified",
    path,
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: 0,
    content: { kind: "text", hunks: [{ oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, section: "", lines: diffLines }] },
  }
  return { diff, noise: null, after: lines.map((line) => (line.startsWith("+") ? line.slice(1) : line)).join("\n") }
}

function added(path: string, code: string): ScannedFile {
  return changedFile(path, code.split("\n").map((line) => `+${line}`).join("\n"))
}

function summary(findings: readonly Risk[]): string[] {
  return findings.map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"}`)
}

describe("scanErrorHandling", () => {
  it.each([
    ["TypeScript catch", "src/a.ts", "try { run() } catch (e) {}", ["errors.swallowed@1"]],
    ["a promise's empty catch", "src/a.ts", "load().catch(() => {})", ["errors.swallowed@1"]],
    ["Python pass", "app/a.py", "try:\n    run()\nexcept ValueError:\n    pass", ["errors.swallowed@3"]],
    ["Python ellipsis", "app/a.py", "try:\n    run()\nexcept ValueError:\n    ...", ["errors.swallowed@3"]],
    ["a bare except", "app/a.py", "try:\n    run()\nexcept:\n    log()", ["errors.catch-all@3"]],
    ["BaseException", "app/a.py", "try:\n    run()\nexcept BaseException:\n    log()", ["errors.catch-all@3"]],
    ["Java catch", "src/A.java", "class A { void f() { try { g(); } catch (IOException e) { } } }", ["errors.swallowed@1"]],
    ["Java Throwable", "src/A.java", "class A { void f() { try { g(); } catch (Throwable t) { log(t); } } }", ["errors.catch-all@1"]],
    ["Kotlin catch", "src/A.kt", "fun f() { try { g() } catch (e: IOException) { } }", ["errors.swallowed@1"]],
    ["C# catch", "src/A.cs", "class A { void F() { try { G(); } catch (IOException) { } } }", ["errors.swallowed@1"]],
    ["C++ catch (...)", "src/a.cpp", "void f() { try { g(); } catch (...) { log(); } }", ["errors.catch-all@1"]],
    ["Go's empty error check", "a.go", "package a\nfunc f() {\n\tif err != nil {\n\t}\n}", ["errors.swallowed@3"]],
    ["Go's discarded call", "a.go", "package a\nfunc f() {\n\t_ = c.Close()\n}", ["errors.result-discarded@3"]],
    ["Rust unwrap and expect", "src/a.rs", 'fn f() {\n    let x = g().unwrap();\n    let y = h().expect("y");\n}', ["errors.may-panic@2", "errors.may-panic@3"]],
  ])("flags %s", async (_case, path, code, expected) => {
    expect(summary(await scanErrorHandling([added(path, code)]))).toEqual(expected)
  })

  it.each([
    ["a handler explained by a comment", "src/a.ts", "try { run() } catch (e) {\n  // Optional: the cache may be missing.\n}"],
    ["a handler that does something", "app/a.py", "try:\n    run()\nexcept ValueError as e:\n    log(e)"],
    ["Rust tests", "src/a.rs", "#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { g().unwrap(); }\n}"],
    ["a test file", "src/a.test.ts", "try { run() } catch (e) {}"],
    ["a promise catch that returns a fallback", "src/a.ts", 'load().catch(() => "")\nstop().catch(() => undefined)'],
    ["Go's _ = x, which silences an unused variable", "a.go", "package a\nfunc f(x int) {\n\t_ = x\n}"],
  ])("leaves alone %s", async (_case, path, code) => {
    expect(await scanErrorHandling([added(path, code)])).toEqual([])
  })

  it("only looks at code the PR adds", async () => {
    const file = changedFile("src/a.ts", ["try { old() } catch (e) {}", "+try { fresh() } catch (e) {}"].join("\n"))
    expect(summary(await scanErrorHandling([file]))).toEqual(["errors.swallowed@2"])
  })
})
