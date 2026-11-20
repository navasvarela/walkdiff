import { dirname, posix } from "node:path"
import { changedUnitsOf, isBehaviourChange, UnitImpactStatus } from "@walkdiff/review-model"
import type { ChangedFile, CommitSha } from "@walkdiff/review-model"
import { parse as parseToml } from "smol-toml"
import { readBlobs } from "../../blobs.ts"
import { ISOLATED_CONFIG_ENV, runGit } from "../../git.ts"
import { field, recordOrEmpty, stringField } from "../dependencies/fields.ts"
import { escapeRegExp } from "../../impact/candidateFiles.ts"
import { isSpecificName } from "../breaking/codeMentions.ts"
import { addedLines } from "../scannedFile.ts"

/** A workspace package's behaviour changes, and the names they define or change. */
export interface Area {
  /** The package's folder, or "" for the repository root. */
  readonly root: string
  readonly files: readonly ChangedFile[]
  /** Behaviour units changed in it. */
  readonly units: number
}

// The files that make a folder a package of its own in a monorepo.
const PACKAGE_MANIFESTS: ReadonlySet<string> = new Set(["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "mix.exs", "pubspec.yaml"])
const REPOSITORY_ROOT = ""

/** A workspace package: its folder, the name others depend on it by, and the names it depends on. */
export interface WorkspacePackage {
  readonly root: string
  readonly name: string | undefined
  readonly dependsOn: ReadonlySet<string>
}

/**
 * The workspace packages at `head`: every folder below the root with a package manifest, with
 * what `package.json`, `Cargo.toml` and `go.mod` say about their names and dependencies.
 */
export async function workspacePackages(repoDir: string, head: CommitSha): Promise<WorkspacePackage[]> {
  const listing = await runGit(["ls-tree", "-r", "-z", "--name-only", head], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })
  const manifests = listing.split("\0").filter((path) => PACKAGE_MANIFESTS.has(posix.basename(path)) && !path.includes("node_modules/") && dirname(path) !== ".")
  const blobs = await readBlobs(repoDir, manifests.map((path) => ({ commit: head, path })))
  const byRoot = new Map<string, WorkspacePackage>()
  manifests.forEach((path, index) => {
    const root = dirname(path)
    const read = readManifest(posix.basename(path), blobs.at(index)?.toString("utf8") ?? "")
    const known = byRoot.get(root)
    byRoot.set(root, { root, name: known?.name ?? read.name, dependsOn: new Set([...(known?.dependsOn ?? []), ...read.dependsOn]) })
  })
  return [...byRoot.values()]
}

interface ManifestFacts {
  readonly name: string | undefined
  readonly dependsOn: readonly string[]
}

const NO_FACTS: ManifestFacts = { name: undefined, dependsOn: [] }
const NPM_DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
const CARGO_DEPENDENCY_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"]
const GO_MODULE = /^module\s+(\S+)/m
const GO_REQUIREMENT = /^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+v\S+/gm

// Only the formats most monorepos use; a manifest that can't be read just links nothing.
function readManifest(fileName: string, text: string): ManifestFacts {
  try {
    if (fileName === "package.json") {
      const manifest: unknown = JSON.parse(text)
      return { name: stringField(manifest, "name"), dependsOn: NPM_DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(recordOrEmpty(field(manifest, section)))) }
    }
    if (fileName === "Cargo.toml") {
      const manifest = parseToml(text)
      return { name: stringField(field(manifest, "package"), "name"), dependsOn: CARGO_DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(recordOrEmpty(field(manifest, section)))) }
    }
    if (fileName === "go.mod") return { name: GO_MODULE.exec(text)?.[1], dependsOn: [...text.matchAll(GO_REQUIREMENT)].map((match) => match[1] ?? "") }
  } catch {
    // A manifest that doesn't parse names nothing, which only means fewer links.
  }
  return NO_FACTS
}

/** The behaviour changes of each package they fall in, by the deepest package folder holding them. */
export function areasOf(behaviour: readonly ChangedFile[], packages: readonly WorkspacePackage[]): Area[] {
  const deepestFirst = packages.map((workspace) => workspace.root).sort((a, b) => b.length - a.length)
  const byRoot = new Map<string, ChangedFile[]>()
  for (const file of behaviour) {
    const root = deepestFirst.find((candidate) => file.diff.path.startsWith(`${candidate}/`)) ?? REPOSITORY_ROOT
    const files = byRoot.get(root)
    if (files === undefined) byRoot.set(root, [file])
    else files.push(file)
  }
  return [...byRoot].map(([root, files]) => ({ root, files, units: files.reduce((sum, file) => sum + changedUnitsOf(file).filter((unit) => isBehaviourChange(unit.change)).length, 0) }))
}

/**
 * Groups areas that belong together: one declares a dependency on the other, its added lines name
 * a unit the other changes, or a changed unit's traced callers are in the other. Layers of one
 * feature, such as a data format, the code writing it and the page reading it, usually depend on
 * each other without calling each other's new code. Two groups have nothing tying them together.
 */
export function connectedGroups(areas: readonly Area[], packages: readonly WorkspacePackage[]): Area[][] {
  const byRoot = new Map(packages.map((workspace) => [workspace.root, workspace]))
  const declares = (from: Area, to: Area): boolean => {
    const target = byRoot.get(to.root)?.name
    return target !== undefined && byRoot.get(from.root)?.dependsOn.has(target) === true
  }
  const parent = areas.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] ?? root
    return root
  }
  areas.forEach((from, fromIndex) => {
    const uses = mentionMatcher(from)
    areas.forEach((to, toIndex) => {
      const linked = declares(from, to) || (uses !== undefined && usesAny(to, uses)) || isCalledFrom(from, to)
      if (fromIndex !== toIndex && linked) parent[find(toIndex)] = find(fromIndex)
    })
  })
  const groups = new Map<number, Area[]>()
  areas.forEach((area, index) => {
    const group = groups.get(find(index))
    if (group === undefined) groups.set(find(index), [area])
    else group.push(area)
  })
  return [...groups.values()]
}

// Short or plain names such as `get` turn up everywhere, so only specific ones tie areas together.
function mentionMatcher(area: Area): RegExp | undefined {
  const names = [...new Set(area.files.flatMap((file) => changedUnitsOf(file).map((unit) => unit.name)).filter(isSpecificName))]
  if (names.length === 0) return undefined
  return new RegExp(`(?<![\\p{L}\\p{N}_$])(?:${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_$])`, "u")
}

function usesAny(area: Area, names: RegExp): boolean {
  return area.files.some((file) => addedLines(file.diff).some((line) => names.test(line.content)))
}

function isCalledFrom(from: Area, to: Area): boolean {
  const paths = new Set(to.files.map((file) => file.diff.path))
  return from.files.some((file) => changedUnitsOf(file).some((unit) => unit.impact?.status === UnitImpactStatus.Traced && unit.impact.references.some((reference) => paths.has(reference.path))))
}
