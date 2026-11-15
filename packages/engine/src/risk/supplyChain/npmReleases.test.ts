import { afterEach, describe, expect, it, vi } from "vitest"
import { RegistryUnavailableError } from "../dependencies/registryHttp.ts"
import { checkNpmUpgrades, lookUpNpmRelease } from "./npmReleases.ts"
import type { NpmRelease, PackageUpgrade, ReleaseLookup } from "./npmReleases.ts"

const FROM_TOKEN: NpmRelease = { publisher: "alice", maintainers: new Set(["alice", "bob"]), hasProvenance: false, trustedPublisher: false }
const FROM_CI: NpmRelease = { ...FROM_TOKEN, hasProvenance: true }

const upgrade: PackageUpgrade = { name: "pkg", from: "1.0.0", to: "1.0.1", path: "package-lock.json", line: 7 }

function lookUpFrom(before: NpmRelease | undefined, after: NpmRelease | undefined): ReleaseLookup {
  return async (_name, version) => (version === upgrade.from ? before : after)
}

async function rulesFound(before: NpmRelease | undefined, after: NpmRelease | undefined): Promise<string[]> {
  const { findings } = await checkNpmUpgrades([upgrade], lookUpFrom(before, after))
  return findings.map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"}`)
}

describe("checkNpmUpgrades", () => {
  it.each<[string, NpmRelease | undefined, NpmRelease | undefined, string[]]>([
    ["the same maintainer, the same way", FROM_TOKEN, FROM_TOKEN, []],
    ["another maintainer who was already listed", FROM_TOKEN, { ...FROM_TOKEN, publisher: "bob" }, []],
    ["an account that wasn't a maintainer", FROM_TOKEN, { ...FROM_TOKEN, publisher: "mallory" }, ["supply-chain.new-publisher@7"]],
    ["a release without the provenance the last one had", FROM_CI, FROM_TOKEN, ["supply-chain.provenance-dropped@7"]],
    ["both at once", FROM_CI, { ...FROM_TOKEN, publisher: "mallory" }, ["supply-chain.provenance-dropped@7", "supply-chain.new-publisher@7"]],
    ["a move to trusted publishing, whose account isn't a maintainer", FROM_TOKEN, { ...FROM_CI, publisher: "GitHub Actions", trustedPublisher: true }, []],
    ["a release npm doesn't have", FROM_TOKEN, undefined, []],
  ])("%s", async (_case, before, after, expected) => {
    expect(await rulesFound(before, after)).toEqual(expected)
  })

  it("says which upgrades it couldn't check, and keeps the others' findings", async () => {
    const failing: ReleaseLookup = async (name, version) => {
      if (name === "down") throw new RegistryUnavailableError("could not reach npm")
      return version === "1.0.0" ? FROM_TOKEN : { ...FROM_TOKEN, publisher: "mallory" }
    }
    const result = await checkNpmUpgrades([{ ...upgrade, name: "down" }, upgrade], failing)
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["supply-chain.new-publisher"])
    expect(result.problem).toBe("could not reach npm")
  })

  it("checks at most 300 upgrades", async () => {
    const many = Array.from({ length: 301 }, (_, index) => ({ ...upgrade, name: `pkg-${index}` }))
    const lookUp = vi.fn<ReleaseLookup>(async () => FROM_TOKEN)
    const result = await checkNpmUpgrades(many, lookUp)
    expect(lookUp).toHaveBeenCalledTimes(600)
    expect(result.problem).toBe("only the first 300 of 301 upgraded npm packages were checked")
  })
})

describe("lookUpNpmRelease", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("asks for one release and reads its publisher, maintainers and provenance", async () => {
    const fetchRelease = vi.fn<typeof fetch>(async () =>
      Response.json({
        _npmUser: { name: "GitHub Actions", email: "npm-oidc-no-reply@github.com", trustedPublisher: { id: "github" } },
        maintainers: [{ name: "alice", email: "a@example.com" }],
        dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/@acme%2fcore@1.0.0", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } },
      }),
    )
    vi.stubGlobal("fetch", fetchRelease)
    expect(await lookUpNpmRelease("@acme/core", "1.0.0")).toEqual({ publisher: "GitHub Actions", maintainers: new Set(["alice"]), hasProvenance: true, trustedPublisher: true })
    expect(String(fetchRelease.mock.calls[0]?.[0])).toBe("https://registry.npmjs.org/@acme%2Fcore/1.0.0")
  })

  it("returns undefined for a release npm doesn't have", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("", { status: 404 })))
    expect(await lookUpNpmRelease("pkg", "9.9.9")).toBeUndefined()
  })
})
