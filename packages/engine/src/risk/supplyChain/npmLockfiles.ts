import { parse as parseYaml, parseAllDocuments } from "yaml"
import { field, recordOrEmpty, stringField } from "../dependencies/fields.ts"
import { hashesByAlgorithm } from "./lockedPackage.ts"
import type { LockedPackage, LockfileReader } from "./lockedPackage.ts"
import { CONFIGURED_REGISTRY, downloadOrigin, gitOrigin, OriginKind } from "./packageOrigin.ts"
import type { PackageOrigin } from "./packageOrigin.ts"

const FROM_CONFIGURED_REGISTRY: PackageOrigin = { kind: OriginKind.Registry, registry: CONFIGURED_REGISTRY, secure: true }
const NO_HASHES: ReadonlyMap<string, string> = new Map()

export const PACKAGE_LOCK: LockfileReader = { matches: (name) => name === "package-lock.json" || name === "npm-shrinkwrap.json", read: readPackageLock }
export const YARN_LOCK: LockfileReader = { matches: (name) => name === "yarn.lock", read: readYarnLock }
export const PNPM_LOCK: LockfileReader = { matches: (name) => name === "pnpm-lock.yaml", read: readPnpmLock }

// Lockfile v2 and v3 key each install path: "node_modules/a/node_modules/b" is package b. Paths
// without node_modules are the project's own workspaces, and links point at them.
function readPackageLock(text: string): LockedPackage[] {
  const lock: unknown = JSON.parse(text)
  return Object.entries(recordOrEmpty(field(lock, "packages"))).flatMap(([installPath, entry]) => {
    const name = stringField(entry, "name") ?? installPath.split("node_modules/").at(-1)
    const version = stringField(entry, "version")
    const resolved = stringField(entry, "resolved")
    if (!installPath.includes("node_modules/") || name === undefined || version === undefined || field(entry, "link") === true) return []
    return [
      {
        name,
        version,
        origin: resolved === undefined ? FROM_CONFIGURED_REGISTRY : downloadOrigin(resolved),
        hashes: hashesByAlgorithm(stringField(entry, "integrity") ?? ""),
        runsInstallScript: field(entry, "hasInstallScript") === true,
        anchor: `"${installPath}"`,
      },
    ]
  })
}

// Yarn 2 and later write YAML with a `__metadata` entry; Yarn 1 wrote its own format.
function readYarnLock(text: string): LockedPackage[] {
  return /^__metadata:/m.test(text) ? readYarnBerryLock(text) : readYarnClassicLock(text)
}

interface ClassicEntry {
  readonly header: string
  readonly fields: Map<string, string>
}

// A header names every requirement the entry satisfies, `"a@^1", a@^1.2:`, followed by its fields
// indented by two spaces. Deeper lines list its own dependencies.
const CLASSIC_FIELD = /^ {2}(version|resolved|integrity) "?([^"]*)"?\s*$/

function readYarnClassicLock(text: string): LockedPackage[] {
  const entries: ClassicEntry[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue
    if (!line.startsWith(" ")) {
      entries.push({ header: line, fields: new Map() })
      continue
    }
    const found = CLASSIC_FIELD.exec(line)
    if (found?.[1] !== undefined && found[2] !== undefined) entries.at(-1)?.fields.set(found[1], found[2])
  }
  return entries.flatMap(classicPackage)
}

function classicPackage({ header, fields }: ClassicEntry): LockedPackage[] {
  const requirement = header.replace(/:\s*$/, "").split(",")[0]?.trim().replace(/^"|"$/g, "") ?? ""
  const name = packageNameOf(requirement)
  const version = fields.get("version")
  const resolved = fields.get("resolved")
  if (name === undefined || version === undefined) return []
  return [
    {
      name,
      version,
      origin: resolved === undefined ? FROM_CONFIGURED_REGISTRY : downloadOrigin(resolved),
      hashes: hashesByAlgorithm(fields.get("integrity") ?? ""),
      runsInstallScript: false,
      anchor: header,
    },
  ]
}

function readYarnBerryLock(text: string): LockedPackage[] {
  const lock: unknown = parseYaml(text)
  const cacheKey = String(field(field(lock, "__metadata"), "cacheKey") ?? "")
  return Object.entries(recordOrEmpty(lock)).flatMap(([key, entry]) => {
    const resolution = stringField(entry, "resolution")
    const version = field(entry, "version")
    const name = resolution === undefined ? undefined : packageNameOf(resolution)
    if (key === "__metadata" || resolution === undefined || name === undefined || version === undefined) return []
    return [
      {
        name,
        version: String(version),
        origin: berryOrigin(resolution.slice(name.length + 1)),
        hashes: berryChecksum(stringField(entry, "checksum"), cacheKey),
        runsInstallScript: false,
        anchor: `resolution: "${resolution}"`,
      },
    ]
  })
}

// Yarn's checksums depend on its cache format, which is named before a slash (`10c0/abc`) or, in
// older lockfiles, once in `__metadata.cacheKey`. Hashes in different cache formats never match.
function berryChecksum(checksum: string | undefined, cacheKey: string): ReadonlyMap<string, string> {
  if (checksum === undefined) return NO_HASHES
  const slash = checksum.indexOf("/")
  return slash === -1 ? new Map([[cacheKey, checksum]]) : new Map([[checksum.slice(0, slash), checksum.slice(slash + 1)]])
}

const BERRY_LOCAL_PROTOCOLS = /^(?:workspace|link|portal|file|patch):/

// What follows the name in a Yarn 2+ resolution: `npm:1.2.3`, `https://…`, a git URL with
// `#commit=…`, or a protocol for the project's own files. `exec:` runs a script to build the package.
function berryOrigin(reference: string): PackageOrigin {
  if (reference.startsWith("npm:")) return FROM_CONFIGURED_REGISTRY
  if (BERRY_LOCAL_PROTOCOLS.test(reference)) return { kind: OriginKind.Local }
  if (reference.includes("#commit=")) return gitOrigin(reference)
  if (reference.startsWith("exec:")) return { kind: OriginKind.Url, url: reference, secure: true }
  return downloadOrigin(reference)
}

// pnpm keyed packages `/name/1.0.0` before lockfile v6 and `name@1.0.0(peer@2)` since.
const SLASH_KEYS_BEFORE_VERSION = 6

// pnpm 10 and later can write two documents: the tools pnpm itself needs (its own version and
// config dependencies), then the project's packages. Both pin packages that get installed.
function readPnpmLock(text: string): LockedPackage[] {
  const packages: LockedPackage[] = []
  for (const document of parseAllDocuments(text)) {
    const [error] = document.errors
    if (error !== undefined) throw error
    packages.push(...readPnpmDocument(document.toJS()))
  }
  return packages
}

function readPnpmDocument(lock: unknown): LockedPackage[] {
  const slashKeys = Number.parseFloat(String(field(lock, "lockfileVersion"))) < SLASH_KEYS_BEFORE_VERSION
  return Object.entries(recordOrEmpty(field(lock, "packages"))).flatMap(([key, entry]) => {
    const id = slashKeys ? slashKeyId(key) : atKeyId(key)
    const name = stringField(entry, "name") ?? id.name
    const version = stringField(entry, "version") ?? id.version
    if (name === undefined || version === undefined) return []
    const resolution = field(entry, "resolution")
    return [
      {
        name,
        version,
        origin: pnpmOrigin(resolution),
        hashes: hashesByAlgorithm(stringField(resolution, "integrity") ?? ""),
        runsInstallScript: field(entry, "requiresBuild") === true,
        anchor: key,
      },
    ]
  })
}

interface PackageId {
  readonly name: string | undefined
  readonly version: string | undefined
}

function atKeyId(key: string): PackageId {
  const id = key.replace(/^\//, "").replace(/\(.*$/, "")
  const name = packageNameOf(id)
  return { name, version: name === undefined ? undefined : id.slice(name.length + 1) }
}

// `/@scope/name/1.0.0_peer@2`: the name is one segment, or two for a scope.
function slashKeyId(key: string): PackageId {
  const segments = key.replace(/^\//, "").split("/")
  const nameLength = segments[0]?.startsWith("@") === true ? 2 : 1
  if (segments.length !== nameLength + 1) return { name: undefined, version: undefined }
  return { name: segments.slice(0, nameLength).join("/"), version: segments.at(-1)?.replace(/_.*$/, "") }
}

function pnpmOrigin(resolution: unknown): PackageOrigin {
  const type = stringField(resolution, "type")
  const tarball = stringField(resolution, "tarball")
  if (type === "git") return gitOrigin(stringField(resolution, "repo") ?? "")
  if (type === "directory" || tarball?.startsWith("file:") === true) return { kind: OriginKind.Local }
  return tarball === undefined ? FROM_CONFIGURED_REGISTRY : downloadOrigin(tarball)
}

/** `@scope/name@^1.0.0` → `@scope/name`; the version starts at the first `@` after the name's own. */
function packageNameOf(requirement: string): string | undefined {
  const at = requirement.indexOf("@", 1)
  return at <= 0 ? undefined : requirement.slice(0, at)
}
