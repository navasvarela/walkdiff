import { describe, expect, it, vi } from "vitest"
import { findMaliciousPackages } from "./osv.ts"
import { assessPackageTrust, isFromRegistry, isOneEditAway, isPrivatePackage, lookUpOnRegistry, RegistryUnavailableError } from "./packageTrust.ts"
import type { DeclaredPackage, RegistryEntry, TrustSources } from "./packageTrust.ts"
import { Ecosystem, manifestFormatFor } from "./packages.ts"

const NOW = new Date("2026-11-02T00:00:00Z")
const OLD: RegistryEntry = { status: "published", firstPublished: new Date("2020-01-01T00:00:00Z") }

const declared = (name: string, ecosystem: Ecosystem = Ecosystem.Npm): DeclaredPackage => ({ ecosystem, name, requirement: "^1.0.0", path: "package.json", line: 3 })

function sources(overrides: Partial<TrustSources> = {}): TrustSources {
  return { lookUp: async () => OLD, maliciousNames: async () => new Map(), now: NOW, ...overrides }
}

const ids = async (packages: readonly DeclaredPackage[], source: TrustSources): Promise<readonly string[]> => (await assessPackageTrust(packages, source)).findings.map((finding) => finding.ruleId)

describe("assessPackageTrust", () => {
  it("says nothing about an established package", async () => {
    expect(await assessPackageTrust([declared("left-pad-utils")], sources())).toEqual({ findings: [], problem: undefined })
  })

  it("flags a known malicious package as high, with what to do", async () => {
    const { findings } = await assessPackageTrust([declared("evil-thing")], sources({ maliciousNames: async () => new Map([["evil-thing", "MAL-2024-1"]]) }))
    expect(findings).toMatchObject([{ ruleId: "trust.malicious", severity: "high", title: "`evil-thing` is a known malicious package", category: "dependency", location: { path: "package.json", line: 3 } }])
    expect(findings.at(0)?.detail).toContain("MAL-2024-1")
  })

  it.each([
    [Ecosystem.Npm, "npm"],
    [Ecosystem.PyPI, "PyPI"],
    [Ecosystem.Crates, "crates.io"],
  ])("flags a %s package that isn't on its registry, as it may be made up", async (ecosystem, registry) => {
    const { findings } = await assessPackageTrust([declared("requests-stealth-bypass", ecosystem)], sources({ lookUp: async () => ({ status: "missing" }) }))
    expect(findings).toMatchObject([{ ruleId: "trust.missing", severity: "medium", title: `\`requests-stealth-bypass\` isn't on ${registry}` }])
  })

  it.each([
    ["2026-11-02T00:00:00Z", "first published today"],
    ["2026-11-01T00:00:00Z", "first published yesterday"],
    ["2026-10-04T00:00:00Z", "first published 29 days ago"],
  ])("flags a package first published on %s", async (date, phrase) => {
    const { findings } = await assessPackageTrust([declared("fresh-package")], sources({ lookUp: async () => ({ status: "published", firstPublished: new Date(date) }) }))
    expect(findings.at(0)?.title).toContain(phrase)
  })

  it("stops flagging a package at 30 days", async () => {
    expect(await ids([declared("fresh-package")], sources({ lookUp: async () => ({ status: "published", firstPublished: new Date("2026-10-03T00:00:00Z") }) }))).toEqual([])
  })

  it.each([
    ["expresss", Ecosystem.Npm, "express"],
    ["lodahs", Ecosystem.Npm, "lodash"],
    ["request-s", Ecosystem.PyPI, "requests"],
    ["python_dotenv2", Ecosystem.PyPI, "python-dotenv"],
    ["completely-different", Ecosystem.PyPI, undefined],
    ["serde-json", Ecosystem.Crates, "serde_json"],
  ] as const)("compares %s with popular names", async (name, ecosystem, target) => {
    const { findings } = await assessPackageTrust([declared(name, ecosystem)], sources())
    expect(findings.at(0)?.title).toBe(target === undefined ? undefined : `\`${name}\` looks like \`${target}\``)
  })

  it.each(["express", "@acme/express", "vuex"])("doesn't call %s a lookalike", async (name) => {
    expect(await ids([declared(name)], sources())).toEqual([])
  })

  it("doesn't call a popular package's own Python spelling a lookalike", async () => {
    expect(await ids([declared("python_dotenv", Ecosystem.PyPI)], sources())).toEqual([])
  })

  it("doesn't look up packages already known to be popular", async () => {
    const asked: string[] = []
    await assessPackageTrust([declared("express"), declared("something-else")], sources({ lookUp: async (_ecosystem, name) => { asked.push(name); return OLD } }))
    expect(asked).toEqual(["something-else"])
  })

  it("reports a registry that can't answer as not checked, and keeps other findings", async () => {
    const result = await assessPackageTrust([declared("expresss")], sources({ lookUp: async () => Promise.reject(new RegistryUnavailableError("could not reach npm")) }))
    expect(result.problem).toBe("could not reach npm")
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["trust.lookalike"])
  })

  it("caps lookups, as a PR chooses how many packages it adds, and says so", async () => {
    const packages = Array.from({ length: 105 }, (_, index) => declared(`package-number-${index}`))
    let asked = 0
    const result = await assessPackageTrust(packages, sources({ lookUp: async () => { asked++; return OLD } }))
    expect(asked).toBe(100)
    expect(result.problem).toContain("100 of 105")
  })
})

describe("what the check skips or reads", () => {
  it.each([
    ["^1.2.3", true],
    ["==1.0.0", true],
    ["*", true],
    ["workspace:*", false],
    ["file:../x", false],
    ["link:../x", false],
    ["path:../x", false],
    ["git+https://github.com/a/b", false],
    ["github:a/b", false],
    ["https://example.com/a.tgz", false],
    ["@ https://example.com/a.whl", false],
    ["npm:other@1", false],
  ])("treats %s as from a registry: %s", (requirement, expected) => {
    expect(isFromRegistry(requirement)).toBe(expected)
  })

  it.each([
    ["@acme/core", ["@acme/*"], true],
    ["acme-tool", ["acme-*"], true],
    ["exact", ["exact"], true],
    ["@other/core", ["@acme/*"], false],
    ["express", [], false],
  ] as const)("matches %s against %j", (name, patterns, expected) => {
    expect(isPrivatePackage(name, patterns)).toBe(expected)
  })

  it.each([
    ["express", "expresss", true],
    ["express", "expres", true],
    ["express", "exprezs", true],
    ["express", "exrpess", true],
    ["express", "express", false],
    ["express", "exprss_", false],
    ["express", "espresso", false],
  ])("%s and %s being one edit apart: %s", (a, b, expected) => {
    expect(isOneEditAway(a, b)).toBe(expected)
  })

  it.each(["requirements/base.in", "requirements/dev.txt", "src/requirements/x.in", "requirements-dev.in", "requirements.txt"])("reads %s as a Python manifest", (path) => {
    expect(manifestFormatFor(path)?.parse("requests-stealth-bypass==1.0.0\n# comment\nlanggraph-vibe-core>=0.0.1\n")).toEqual(new Map([["requests-stealth-bypass", "==1.0.0"], ["langgraph-vibe-core", ">=0.0.1"]]))
  })

  it("keeps local Cargo dependencies recognizable", () => {
    const parsed = manifestFormatFor("Cargo.toml")?.parse('[dependencies]\nserde = "1"\nmine = { path = "../mine" }\nshared = { workspace = true }\n')
    expect(parsed).toEqual(new Map([["serde", "1"], ["mine", "path:../mine"], ["shared", "workspace:"]]))
  })
})

describe("lookUpOnRegistry", () => {
  it.each([
    ["@acme/core", "https://registry.npmjs.org/@acme%2Fcore"],
    ["plain", "https://registry.npmjs.org/plain"],
    ["@a@b/c", "https://registry.npmjs.org/@a%40b%2Fc"],
    ["../../x", "https://registry.npmjs.org/..%2F..%2Fx"],
  ])("keeps the npm name %s to one path segment", async (name, expected) => {
    const asked = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }))
    vi.stubGlobal("fetch", asked)
    expect(await lookUpOnRegistry(Ecosystem.Npm, name)).toEqual({ status: "missing" })
    expect(asked.mock.calls.at(0)?.[0]).toBe(expected)
    vi.unstubAllGlobals()
  })
})

describe("findMaliciousPackages", () => {
  it("only reports advisories from OSV's malicious list", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-1" }, { id: "MAL-2024-1" }] }, { vulns: [{ id: "GHSA-2" }] }, {}] }))))
    const found = await findMaliciousPackages([declared("bad"), declared("vulnerable"), declared("fine")])
    expect([...found]).toEqual([["bad", "MAL-2024-1"]])
    vi.unstubAllGlobals()
  })
})
