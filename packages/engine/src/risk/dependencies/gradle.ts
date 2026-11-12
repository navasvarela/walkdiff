import { parse as parseToml } from "smol-toml"
import { Ecosystem } from "./ecosystem.ts"
import type { DeclaredDependencies, PackageVersion } from "./ecosystem.ts"
import { field, isRecord, recordOrEmpty, stringField } from "./fields.ts"
import { toDeclared, toLocked } from "./maven.ts"
import type { MavenCoordinate } from "./maven.ts"

// A build script is code, so only the usual ways of naming a dependency are read: a coordinate
// string, as `implementation("com.squareup.okhttp3:okhttp:4.12.0")`, or Groovy's map form,
// `implementation group: "org.slf4j", name: "slf4j-api", version: "2.0.13"`.
// Configurations are the standard ones and their source-set variants, such as `testImplementation`
// or `debugApi`; other strings in a script, such as `systemProperty("a:b")`, aren't dependencies.
const CONFIGURATION = String.raw`\b(?:\w*(?:[Ii]mplementation|[Aa]pi|[Cc]ompileOnly|[Rr]untimeOnly|[Aa]nnotationProcessor|[Cc]ompile|[Rr]untime)|kapt\w*|ksp\w*|classpath|coreLibraryDesugaring|detektPlugins|lintChecks)`
const PLATFORM = String.raw`(?:(?:platform|enforcedPlatform)\s*\(\s*)?`
const COORDINATE = String.raw`["']([\w.-]+):([\w.-]+)(?::([^"':@\s]+))?(?::[\w.-]+)?(?:@\w+)?["']`
const COORDINATE_STRING = new RegExp(String.raw`${CONFIGURATION}\s*(?:\(\s*)?${PLATFORM}${COORDINATE}`, "g")
const MAP_NOTATION = /\bgroup\s*[:=]\s*["']([\w.-]+)["']\s*,\s*name\s*[:=]\s*["']([\w.-]+)["'](?:\s*,\s*version\s*[:=]\s*["']([^"']+)["'])?/g
// `com.google.guava:guava:33.0.0-jre=compileClasspath,runtimeClasspath`
const LOCKED_LINE = /^([\w.-]+):([\w.-]+):([^=\s]+)=/
// Gradle's rich versions; `strictly` and `require` are what resolution must honour.
const RICH_VERSION_KEYS = ["strictly", "require", "prefer"] as const

export function parseGradleBuild(text: string): DeclaredDependencies {
  return toDeclared(buildCoordinates(text))
}

export function gradleBuildLockfile(text: string): PackageVersion[] {
  return toLocked(buildCoordinates(text))
}

export function parseGradleCatalog(text: string): DeclaredDependencies {
  return toDeclared(catalogCoordinates(text))
}

export function gradleCatalogLockfile(text: string): PackageVersion[] {
  return toLocked(catalogCoordinates(text))
}

export function gradleLockfile(text: string): PackageVersion[] {
  return text.split("\n").flatMap((line) => {
    const [, group, artifact, version] = LOCKED_LINE.exec(line.trim()) ?? []
    return group === undefined || artifact === undefined || version === undefined ? [] : [{ ecosystem: Ecosystem.Maven, name: `${group}:${artifact}`, version }]
  })
}

function buildCoordinates(text: string): MavenCoordinate[] {
  const fromStrings = [...text.matchAll(COORDINATE_STRING)].map(([, group, artifact, version]) => ({ name: `${group}:${artifact}`, version }))
  const fromMaps = [...text.matchAll(MAP_NOTATION)].map(([, group, artifact, version]) => ({ name: `${group}:${artifact}`, version }))
  return [...fromStrings, ...fromMaps]
}

// gradle/libs.versions.toml: `[libraries]` entries as "group:artifact:version", or a table with a
// `module` or `group` and `name`, and a `version` given directly, as a rich version or by `ref`.
function catalogCoordinates(text: string): MavenCoordinate[] {
  const catalog = parseToml(text)
  const versions = recordOrEmpty(field(catalog, "versions"))
  return Object.values(recordOrEmpty(field(catalog, "libraries"))).flatMap((library): MavenCoordinate[] => {
    if (typeof library === "string") {
      const [group, artifact, version] = library.split(":")
      return group === undefined || artifact === undefined ? [] : [{ name: `${group}:${artifact}`, version }]
    }
    const group = stringField(library, "group")
    const artifact = stringField(library, "name")
    const name = stringField(library, "module") ?? (group === undefined || artifact === undefined ? undefined : `${group}:${artifact}`)
    return name === undefined ? [] : [{ name, version: catalogVersion(field(library, "version"), versions) }]
  })
}

function catalogVersion(version: unknown, versions: Record<string, unknown>): string | undefined {
  if (typeof version === "string") return version
  const reference = stringField(version, "ref")
  if (reference !== undefined) return catalogVersion(versions[reference], {})
  if (!isRecord(version)) return undefined
  return RICH_VERSION_KEYS.map((key) => stringField(version, key)).find((value) => value !== undefined)
}
