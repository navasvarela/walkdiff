import { basename } from "node:path"
import { parse as parseToml } from "smol-toml"
import { field, stringField } from "../dependencies/fields.ts"
import { normalizePythonName } from "../dependencies/packages.ts"
import { hashesByAlgorithm } from "./lockedPackage.ts"
import type { LockedPackage, LockfileReader } from "./lockedPackage.ts"
import { gitOrigin, OriginKind, PublicRegistry, registryOrigin } from "./packageOrigin.ts"
import type { PackageOrigin } from "./packageOrigin.ts"

export const CARGO_LOCK: LockfileReader = { matches: (name) => name === "Cargo.lock", read: (text) => tomlPackages(text, cargoPackage) }
export const UV_LOCK: LockfileReader = { matches: (name) => name === "uv.lock", read: (text) => tomlPackages(text, uvPackage, normalizePythonName) }
export const POETRY_LOCK: LockfileReader = { matches: (name) => name === "poetry.lock", read: (text) => tomlPackages(text, poetryPackage, normalizePythonName) }
export const GO_SUM: LockfileReader = { matches: (name) => name === "go.sum", read: readGoSum }

const FROM_PYPI: PackageOrigin = { kind: OriginKind.Registry, registry: PublicRegistry.PyPI, secure: true }
const LOCAL: PackageOrigin = { kind: OriginKind.Local }

/** What each lockfile format says about a package besides its name and version. */
interface PackageDetails {
  readonly origin: PackageOrigin
  readonly hashes: ReadonlyMap<string, string>
  readonly runsInstallScript: boolean
}

interface TomlEntry {
  readonly name: string
  readonly version: string
  readonly entry: unknown
}

// Cargo.lock, uv.lock and poetry.lock all list `[[package]]` tables that start with name and version.
// Python lockfiles keep a package's name as published; the rules compare names the way pip does.
function tomlPackages(text: string, read: (entry: TomlEntry) => PackageDetails, normalizeName: (name: string) => string = (name) => name): LockedPackage[] {
  const packages = field(parseToml(text), "package")
  return (Array.isArray(packages) ? packages : []).flatMap((entry: unknown) => {
    const name = stringField(entry, "name")
    const version = stringField(entry, "version")
    if (name === undefined || version === undefined) return []
    return [{ name: normalizeName(name), version, ...read({ name, version, entry }), anchor: `name = "${name}"\nversion = "${version}"` }]
  })
}

// No source is a path or workspace member; `registry+…` and `sparse+…` are a registry's two kinds of index.
function cargoPackage({ entry }: TomlEntry): PackageDetails {
  const source = stringField(entry, "source")
  const checksum = stringField(entry, "checksum")
  return {
    origin: source === undefined ? LOCAL : source.startsWith("git+") ? gitOrigin(source) : registryOrigin(source.replace(/^(?:registry|sparse)\+/, "")),
    hashes: checksum === undefined ? new Map() : new Map([["sha256", checksum]]),
    runsInstallScript: false,
  }
}

function uvPackage({ entry }: TomlEntry): PackageDetails {
  const source = field(entry, "source")
  const registry = stringField(source, "registry")
  const git = stringField(source, "git")
  const url = stringField(source, "url")
  const origin: PackageOrigin =
    registry !== undefined ? registryOrigin(registry) : git !== undefined ? gitOrigin(git) : url !== undefined ? urlOrigin(url) : LOCAL
  const files = [field(entry, "sdist"), ...arrayOf(field(entry, "wheels"))]
  return { origin, hashes: fileHashes(files.map((file) => ({ file: stringField(file, "url"), hash: stringField(file, "hash") }))), runsInstallScript: false }
}

// Poetry names a package's source only when it isn't PyPI: `legacy` is another index.
function poetryPackage({ entry }: TomlEntry): PackageDetails {
  const source = field(entry, "source")
  const type = stringField(source, "type")
  const url = stringField(source, "url") ?? ""
  const origin: PackageOrigin = type === undefined ? FROM_PYPI : type === "git" ? gitOrigin(url) : type === "url" ? urlOrigin(url) : type === "legacy" ? registryOrigin(url) : LOCAL
  const files = arrayOf(field(entry, "files")).map((file) => ({ file: stringField(file, "file"), hash: stringField(file, "hash") }))
  return { origin, hashes: fileHashes(files), runsInstallScript: false }
}

function urlOrigin(url: string): PackageOrigin {
  return { kind: OriginKind.Url, url, secure: !url.startsWith("http:") }
}

function fileHashes(files: readonly { readonly file: string | undefined; readonly hash: string | undefined }[]): ReadonlyMap<string, string> {
  return new Map(files.flatMap(({ file, hash }) => (file === undefined || hash === undefined ? [] : [...hashesByAlgorithm(hash, `${basename(file)} `)])))
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// `module version h1:hash`, and `module version/go.mod h1:hash` for its go.mod alone. Go's checksum
// database makes these permanent, so the module proxy a build uses doesn't matter here.
const GO_SUM_LINE = /^(\S+) (\S+) (h1:\S+)$/
const GO_MODULES: PackageOrigin = { kind: OriginKind.Registry, registry: "the Go module proxy", secure: true }

function readGoSum(text: string): LockedPackage[] {
  return text.split("\n").flatMap((line) => {
    const found = GO_SUM_LINE.exec(line.trim())
    if (found?.[1] === undefined || found[2] === undefined || found[3] === undefined) return []
    return [{ name: found[1], version: found[2], origin: GO_MODULES, hashes: new Map([["h1", found[3]]]), runsInstallScript: false, anchor: `${found[1]} ${found[2]} ` }]
  })
}
