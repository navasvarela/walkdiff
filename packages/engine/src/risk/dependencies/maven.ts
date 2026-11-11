import { Ecosystem } from "./ecosystem.ts"
import type { DeclaredDependencies, PackageVersion } from "./ecosystem.ts"

/** A Maven or Gradle dependency: `group:artifact`, the name OSV and deps.dev use, and its version. */
export interface MavenCoordinate {
  readonly name: string
  /** As written, or undefined when the build leaves it to a BOM, a parent or a property it doesn't define. */
  readonly version: string | undefined
}

const COMMENT = /<!--[\s\S]*?-->/g
// Sections whose `<dependency>` tags aren't the project's own dependencies: managed versions,
// build plugins' own dependencies, and what a dependency leaves out.
const NOT_PROJECT_DEPENDENCIES = [/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, /<build>[\s\S]*?<\/build>/g, /<reporting>[\s\S]*?<\/reporting>/g, /<exclusions>[\s\S]*?<\/exclusions>/g]
const DEPENDENCY = /<dependency>([\s\S]*?)<\/dependency>/g
const PROPERTIES = /<properties>([\s\S]*?)<\/properties>/g
const PROPERTY = /<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g
const PROPERTY_REFERENCE = /\$\{([^}]+)\}/g
const UNRESOLVED = "${"
// `[1.0,2.0)` is a range; LATEST and RELEASE are whatever is newest when the build runs.
// Gradle adds `1.+`, `latest.release` and versions taken from `$variables`.
const NOT_EXACT_VERSION = /^[[(]|[,\s]|^(?:LATEST|RELEASE)$|^latest\.|\$|\+$/
const ANY_VERSION = "*"

// Dependencies on the project's own modules are built here, not fetched from a registry.
const INTERNAL_REQUIREMENT = "workspace:"
const PROJECT_SECTIONS = [/<parent>[\s\S]*?<\/parent>/g, /<dependencies>[\s\S]*?<\/dependencies>/g, /<profiles>[\s\S]*?<\/profiles>/g]

export function parsePom(text: string): DeclaredDependencies {
  const { coordinates, ownGroup } = readPom(text)
  return new Map(coordinates.map((coordinate) => [coordinate.name, isInternal(coordinate, ownGroup) ? INTERNAL_REQUIREMENT : (coordinate.version ?? ANY_VERSION)]))
}

export function pomLockfile(text: string): PackageVersion[] {
  const { coordinates, ownGroup } = readPom(text)
  return toLocked(coordinates.filter((coordinate) => !isInternal(coordinate, ownGroup)))
}

// A sibling module shares the group and takes the build's own version, `${project.version}`. A
// same-group artifact with a version of its own, as Apache Commons modules use each other, is published.
function isInternal(coordinate: MavenCoordinate, ownGroup: string | undefined): boolean {
  return ownGroup !== undefined && coordinate.version === undefined && coordinate.name.startsWith(`${ownGroup}:`)
}

export function toDeclared(coordinates: readonly MavenCoordinate[]): DeclaredDependencies {
  return new Map(coordinates.map((coordinate) => [coordinate.name, coordinate.version ?? ANY_VERSION]))
}

/** The coordinates that name one exact version, which is what OSV can check. */
export function toLocked(coordinates: readonly MavenCoordinate[]): PackageVersion[] {
  return coordinates.flatMap(({ name, version }) => (version === undefined || NOT_EXACT_VERSION.test(version) ? [] : [{ ecosystem: Ecosystem.Maven, name, version }]))
}

interface Pom {
  readonly coordinates: readonly MavenCoordinate[]
  /** The project's group, or its parent's when it inherits one; its modules share it. */
  readonly ownGroup: string | undefined
}

// A pom is XML, but these few elements are plain enough to read without an XML parser.
function readPom(text: string): Pom {
  const withoutComments = text.replace(COMMENT, "")
  const properties = readProperties(withoutComments)
  const projectOnly = withoutSections(withoutComments, NOT_PROJECT_DEPENDENCIES)
  const coordinates = [...projectOnly.matchAll(DEPENDENCY)].flatMap((match) => {
    const body = match[1] ?? ""
    const written = elementText(body, "groupId")
    // `${project.groupId}` is unresolved here, and names the project's own modules.
    const group = written === undefined ? undefined : resolveProperties(written, properties)
    const artifact = elementText(body, "artifactId")
    if (group === undefined || artifact === undefined) return []
    const version = elementText(body, "version")
    return [{ name: `${group}:${artifact}`, version: version === undefined ? undefined : resolveProperties(version, properties) }]
  })
  const ownGroup = elementText(withoutSections(projectOnly, PROJECT_SECTIONS), "groupId") ?? elementText(/<parent>([\s\S]*?)<\/parent>/.exec(withoutComments)?.[1] ?? "", "groupId")
  return { coordinates, ownGroup }
}

function withoutSections(xml: string, sections: readonly RegExp[]): string {
  return sections.reduce((current, section) => current.replace(section, ""), xml)
}

function readProperties(pom: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>()
  for (const section of pom.matchAll(PROPERTIES)) {
    for (const [, key, value] of (section[1] ?? "").matchAll(PROPERTY)) {
      if (key !== undefined && value !== undefined) properties.set(key, value)
    }
  }
  return properties
}

// `${jackson.version}` from `<properties>`; undefined when one isn't defined here, as with a parent's.
function resolveProperties(value: string, properties: ReadonlyMap<string, string>): string | undefined {
  const resolved = value.replace(PROPERTY_REFERENCE, (reference, key: string) => properties.get(key) ?? reference)
  return resolved.includes(UNRESOLVED) ? undefined : resolved
}

function elementText(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}>\\s*([^<]*?)\\s*</${element}>`).exec(xml)?.[1]
}
