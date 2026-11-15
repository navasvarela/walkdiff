import { describe, expect, it } from "vitest"
import type { LockedPackage } from "./lockedPackage.ts"
import { downloadOrigin, registryOrigin } from "./packageOrigin.ts"
import type { PackageOrigin } from "./packageOrigin.ts"
import { npmUpgrades } from "./upgrades.ts"

function locked(name: string, version: string, origin: PackageOrigin = registryOrigin("https://registry.npmjs.org")): LockedPackage {
  return { name, version, origin, hashes: new Map(), runsInstallScript: false, anchor: `"node_modules/${name}@${version}"` }
}

function upgradesBetween(before: readonly LockedPackage[], after: readonly LockedPackage[], privatePackages: readonly string[] = []): string[] {
  const text = after.map((entry) => entry.anchor).join("\n")
  return npmUpgrades({ path: "package-lock.json", before, after, text }, privatePackages).map((found) => `${found.name} ${found.from}→${found.to}@${found.line ?? "-"}`)
}

describe("npmUpgrades", () => {
  it("pairs each new version with the highest earlier one in its release line", () => {
    const before = [locked("a", "1.2.0"), locked("a", "2.0.0"), locked("a", "1.10.0"), locked("b", "0.7.28"), locked("b", "0.8.0")]
    const after = [locked("a", "1.11.0"), locked("a", "2.0.0"), locked("b", "0.7.29")]
    expect(upgradesBetween(before, after)).toEqual(["a 1.10.0→1.11.0@1", "b 0.7.28→0.7.29@3"])
  })

  it("leaves out new majors, downgrades and a nested older copy beside a newer one", () => {
    expect(upgradesBetween([locked("a", "1.9.0"), locked("b", "2.1.0"), locked("c", "7.7.4")], [locked("a", "2.0.0"), locked("b", "2.0.0"), locked("c", "5.7.2")])).toEqual([])
  })

  it("leaves out new packages, private ones, non-registry sources and repeats", () => {
    const before = [locked("a", "1.0.0"), locked("@acme/core", "1.0.0"), locked("b", "1.0.0")]
    const after = [locked("new", "1.0.0"), locked("@acme/core", "1.1.0"), locked("b", "1.1.0", downloadOrigin("https://example.com/b.tgz")), locked("a", "1.0.1"), locked("a", "1.0.1")]
    expect(upgradesBetween(before, after, ["@acme/*"])).toEqual(["a 1.0.0→1.0.1@4"])
  })

  it("orders prereleases before their release", () => {
    expect(upgradesBetween([locked("a", "1.0.0-beta.1"), locked("a", "0.9.0")], [locked("a", "1.0.0")])).toEqual(["a 1.0.0-beta.1→1.0.0@1"])
  })
})
