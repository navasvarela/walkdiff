import { describe, expect, it } from "vitest"
import type { LockedPackage } from "./lockedPackage.ts"
import { lockfileFindings } from "./lockfileRules.ts"
import { downloadOrigin, gitOrigin, registryOrigin } from "./packageOrigin.ts"
import type { PackageOrigin } from "./packageOrigin.ts"

const NPM = registryOrigin("https://registry.npmjs.org")
const ACME = registryOrigin("https://npm.acme.internal")

interface PackageFacts {
  readonly origin?: PackageOrigin
  readonly hashes?: Readonly<Record<string, string>>
  readonly runsInstallScript?: boolean
}

function locked(name: string, version: string, facts: PackageFacts = {}): LockedPackage {
  return {
    name,
    version,
    origin: facts.origin ?? NPM,
    hashes: new Map(Object.entries(facts.hashes ?? { sha512: `sha512-${name}-${version}` })),
    runsInstallScript: facts.runsInstallScript ?? false,
    anchor: `"node_modules/${name}"`,
  }
}

function rulesFound(before: readonly LockedPackage[], after: readonly LockedPackage[], privatePackages: readonly string[] = []): string[] {
  const text = after.map((entry) => `${entry.anchor}: {}`).join("\n")
  return lockfileFindings({ path: "package-lock.json", before, after, text }, privatePackages).map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"}`)
}

describe("lockfileFindings", () => {
  it.each<[string, LockedPackage[], LockedPackage[], string[]]>([
    ["an untouched entry", [locked("a", "1.0.0")], [locked("a", "1.0.0")], []],
    ["a changed hash for the same version", [locked("a", "1.0.0")], [locked("a", "1.0.0", { hashes: { sha512: "sha512-other" } })], ["supply-chain.integrity-changed@1"]],
    ["a hash in another algorithm", [locked("a", "1.0.0", { hashes: { sha1: "sha1-x" } })], [locked("a", "1.0.0", { hashes: { sha512: "sha512-y" } })], []],
    ["a git dependency moved to another commit", [locked("a", "1.0.0", { origin: gitOrigin("git+https://github.com/x/a.git#1") })], [locked("a", "1.0.0", { origin: gitOrigin("git+https://github.com/x/a.git#2"), hashes: { sha512: "z" } })], []],
    ["a new package from git", [], [locked("a", "1.0.0", { origin: gitOrigin("git+ssh://git@github.com/x/a.git#1") })], ["supply-chain.git-source@1"]],
    ["a new package from a URL", [], [locked("a", "1.0.0", { origin: downloadOrigin("https://example.com/a.tgz") })], ["supply-chain.url-source@1"]],
    ["a package over plain http", [locked("a", "1.0.0")], [locked("a", "1.1.0", { origin: downloadOrigin("http://example.com/a.tgz") })], ["supply-chain.insecure-source@1"]],
    ["a package moved from the registry to git", [locked("a", "1.0.0")], [locked("a", "1.0.1", { origin: gitOrigin("git+https://github.com/fork/a.git#1") })], ["supply-chain.source-changed@1"]],
    ["a package moved between npm and its Yarn mirror", [locked("a", "1.0.0", { origin: registryOrigin("https://registry.yarnpkg.com") })], [locked("a", "1.0.1")], []],
    ["a new package that runs an install script", [], [locked("a", "1.0.0", { runsInstallScript: true })], ["supply-chain.install-script@1"]],
    ["an upgrade that adds an install script", [locked("a", "1.0.0")], [locked("a", "1.0.1", { runsInstallScript: true })], ["supply-chain.install-script-added@1"]],
    ["an upgrade that keeps its install script", [locked("a", "1.0.0", { runsInstallScript: true })], [locked("a", "1.0.1", { runsInstallScript: true })], []],
  ])("%s", (_case, before, after, expected) => {
    expect(rulesFound(before, after)).toEqual(expected)
  })

  it("flags a private package that moves to a public registry, instead of a plain source change", () => {
    expect(rulesFound([locked("@acme/core", "1.0.0", { origin: ACME })], [locked("@acme/core", "1.0.1")], ["@acme/*"])).toEqual(["supply-chain.dependency-confusion@1"])
    expect(rulesFound([], [locked("acme-utils", "1.0.0")], ["acme-utils"])).toEqual(["supply-chain.dependency-confusion@1"])
    expect(rulesFound([], [locked("@acme/core", "1.0.0", { origin: ACME })], ["@acme/*"])).toEqual([])
  })

  it("reports a version installed in several places once, on its first entry", () => {
    const after = [locked("a", "1.0.0", { runsInstallScript: true }), locked("b", "1.0.0"), locked("a", "1.0.0", { runsInstallScript: true })]
    expect(rulesFound([], after)).toEqual(["supply-chain.install-script@1"])
  })
})
