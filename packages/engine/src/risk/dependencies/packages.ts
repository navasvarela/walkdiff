import { basename } from "node:path"
import { parse as parseToml } from "smol-toml"

/** OSV's names for the package ecosystems the engine reads. */
export const Ecosystem = { Npm: "npm", Crates: "crates.io", PyPI: "PyPI" } as const
export type Ecosystem = (typeof Ecosystem)[keyof typeof Ecosystem]

export interface PackageVersion {
  readonly ecosystem: Ecosystem
  readonly name: string
  readonly version: string
}

/** What a manifest asks for: package name → version requirement as written. */
export type DeclaredDependencies = ReadonlyMap<string, string>

interface ManifestFormat {
  readonly ecosystem: Ecosystem
  matches(fileName: string): boolean
  parse(text: string): DeclaredDependencies
}

interface LockfileFormat {
  readonly ecosystem: Ecosystem
  matches(fileName: string): boolean
  parse(text: string): readonly PackageVersion[]
}

const REQUIREMENTS_FILE = /^requirements.*\.txt$/
// `name[extra]==1.2.3 ; marker` → name and the rest of the requirement.
const PEP508_REQUIREMENT = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;#]*)/
const PINNED_VERSION = /^==\s*([^\s,;]+)$/

const MANIFESTS: readonly ManifestFormat[] = [
  { ecosystem: Ecosystem.Npm, matches: (name) => name === "package.json", parse: parsePackageJson },
  { ecosystem: Ecosystem.Crates, matches: (name) => name === "Cargo.toml", parse: parseCargoToml },
  { ecosystem: Ecosystem.PyPI, matches: (name) => name === "pyproject.toml", parse: parsePyproject },
  { ecosystem: Ecosystem.PyPI, matches: (name) => REQUIREMENTS_FILE.test(name), parse: parseRequirements },
]

// pnpm-lock.yaml and yarn.lock are not parsed here; osv-scanner reads them when installed.
const LOCKFILES: readonly LockfileFormat[] = [
  { ecosystem: Ecosystem.Npm, matches: (name) => name === "package-lock.json", parse: parsePackageLock },
  { ecosystem: Ecosystem.Crates, matches: (name) => name === "Cargo.lock", parse: (text) => tomlPackages(text, Ecosystem.Crates) },
  { ecosystem: Ecosystem.PyPI, matches: (name) => name === "poetry.lock" || name === "uv.lock", parse: (text) => tomlPackages(text, Ecosystem.PyPI) },
  { ecosystem: Ecosystem.PyPI, matches: (name) => REQUIREMENTS_FILE.test(name), parse: pinnedRequirements },
]

export const UNREAD_LOCKFILES: ReadonlySet<string> = new Set(["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"])
// Binary, and not readable by osv-scanner either.
export const UNSCANNABLE_LOCKFILES: ReadonlySet<string> = new Set(["bun.lockb"])

// pip-tools projects keep their inputs in a folder, as requirements/base.in or requirements/dev.txt.
const REQUIREMENTS_FOLDER_FILE = /(^|\/)requirements\/[^/]+\.(in|txt)$/
const REQUIREMENTS_INPUT_FILE = /^requirements.*\.in$/

export function manifestFormatFor(path: string): ManifestFormat | undefined {
  if (REQUIREMENTS_FOLDER_FILE.test(path) || REQUIREMENTS_INPUT_FILE.test(basename(path))) return { ecosystem: Ecosystem.PyPI, matches: () => true, parse: parseRequirements }
  return MANIFESTS.find((format) => format.matches(basename(path)))
}

export function lockfileFormatFor(path: string): LockfileFormat | undefined {
  return LOCKFILES.find((format) => format.matches(basename(path)))
}

function parsePackageJson(text: string): DeclaredDependencies {
  const manifest: unknown = JSON.parse(text)
  const declared = new Map<string, string>()
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, requirement] of stringEntries(field(manifest, section))) {
      declared.set(name, requirement)
    }
  }
  return declared
}

function parseCargoToml(text: string): DeclaredDependencies {
  const manifest = parseToml(text)
  const declared = new Map<string, string>()
  const sections = [
    field(manifest, "dependencies"),
    field(manifest, "dev-dependencies"),
    field(manifest, "build-dependencies"),
    field(field(manifest, "workspace"), "dependencies"),
  ]
  for (const section of sections) {
    for (const [name, value] of Object.entries(isRecord(section) ? section : {})) {
      // `serde = "1"`, or a table such as `serde = { version = "1", features = [...] }`.
      const requirement = typeof value === "string" ? value : stringField(value, "version") ?? cargoSource(value) ?? "*"
      declared.set(name, requirement)
    }
  }
  return declared
}

// The source of a dependency that doesn't come from crates.io, in the form the trust check recognizes.
function cargoSource(value: unknown): string | undefined {
  const git = stringField(value, "git")
  if (git !== undefined) return git
  const path = stringField(value, "path")
  if (path !== undefined) return `path:${path}`
  return field(value, "workspace") === true ? "workspace:" : undefined
}

function parsePyproject(text: string): DeclaredDependencies {
  const manifest = parseToml(text)
  const declared = new Map<string, string>()
  const project = field(manifest, "project")
  const requirementLists = [field(project, "dependencies"), ...Object.values(recordOrEmpty(field(project, "optional-dependencies")))]
  for (const list of requirementLists) {
    for (const requirement of Array.isArray(list) ? list : []) {
      if (typeof requirement !== "string") continue
      const parsed = PEP508_REQUIREMENT.exec(requirement)
      if (parsed?.[1] !== undefined) declared.set(normalizePythonName(parsed[1]), (parsed[2] ?? "").trim() || "*")
    }
  }
  const poetry = field(field(field(manifest, "tool"), "poetry"), "dependencies")
  for (const [name, value] of Object.entries(recordOrEmpty(poetry))) {
    if (name === "python") continue
    declared.set(normalizePythonName(name), typeof value === "string" ? value : stringField(value, "version") ?? "*")
  }
  return declared
}

function parseRequirements(text: string): DeclaredDependencies {
  const declared = new Map<string, string>()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    // Options (-r, -e, --index-url) and comments are not requirements.
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("-")) continue
    const parsed = PEP508_REQUIREMENT.exec(trimmed)
    if (parsed?.[1] !== undefined) declared.set(normalizePythonName(parsed[1]), (parsed[2] ?? "").trim() || "*")
  }
  return declared
}

function parsePackageLock(text: string): PackageVersion[] {
  const lock: unknown = JSON.parse(text)
  // Lockfile v2/v3 key each install path: "node_modules/a/node_modules/b" is package b.
  return Object.entries(recordOrEmpty(field(lock, "packages"))).flatMap(([installPath, entry]) => {
    const version = stringField(entry, "version")
    const name = installPath.split("node_modules/").at(-1)
    return installPath === "" || name === undefined || version === undefined ? [] : [{ ecosystem: Ecosystem.Npm, name, version }]
  })
}

function tomlPackages(text: string, ecosystem: Ecosystem): PackageVersion[] {
  const packages = field(parseToml(text), "package")
  return (Array.isArray(packages) ? packages : []).flatMap((entry: unknown) => {
    const name = stringField(entry, "name")
    const version = stringField(entry, "version")
    if (name === undefined || version === undefined) return []
    return [{ ecosystem, name: ecosystem === Ecosystem.PyPI ? normalizePythonName(name) : name, version }]
  })
}

function pinnedRequirements(text: string): PackageVersion[] {
  return [...parseRequirements(text)].flatMap(([name, requirement]) => {
    const version = PINNED_VERSION.exec(requirement)?.[1]
    return version === undefined ? [] : [{ ecosystem: Ecosystem.PyPI, name, version }]
  })
}

// PEP 503: names compare case-insensitively with runs of -, _ and . treated alike.
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === "string" ? found : undefined
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringEntries(value: unknown): [string, string][] {
  return Object.entries(recordOrEmpty(value)).flatMap(([key, entry]) => (typeof entry === "string" ? [[key, entry]] : []))
}
