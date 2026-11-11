import { dirname, posix } from "node:path"
import { SourceLanguage } from "@walkdiff/review-model"
import type { CommitSha } from "@walkdiff/review-model"
import { z } from "zod"
import { readBlobs } from "../../blobs.ts"
import { ISOLATED_CONFIG_ENV, runGit } from "../../git.ts"
import { languageSpecFor } from "../../syntax/languages.ts"

/** Whether code outside this repository can reach `name` (a top-level item) in the file at `path`. */
export type LibrarySurface = (path: string, name: string) => boolean

// Code in these folders ships with no one, or is run rather than imported.
const NON_API_FOLDERS: ReadonlySet<string> = new Set(["examples", "example", "docs", "doc", "scripts", "script", "tools", "benches", "benchmarks", "bench", "fixtures", "testdata", "demo", "demos", "migrations"])
// Enough for any real package's chain of `export ... from`; a limit because repositories are untrusted input.
const MAX_REEXPORT_FILES = 300

interface RepositoryFiles {
  readonly commit: CommitSha
  readonly repoDir: string
  readonly paths: ReadonlySet<string>
}

/**
 * Works out which changed code other projects can import, at the commit they depend on today.
 * A `pub` or `export` alone is a poor sign: binary crates, private packages and apps use both for
 * their own modules, and every caller of those is in the repository where it can be traced.
 * Anything this can't establish counts as not reachable, so unsure code never raises a false alarm.
 */
export async function readLibrarySurface(repoDir: string, commit: CommitSha, changedPaths: readonly string[]): Promise<LibrarySurface> {
  const listing = await runGit(["ls-tree", "-r", "-z", "--name-only", commit], { cwd: repoDir, env: ISOLATED_CONFIG_ENV })
  const repository: RepositoryFiles = { commit, repoDir, paths: new Set(listing.split("\0").filter((path) => path !== "")) }
  const candidates = changedPaths.filter((path) => !path.split("/").some((segment) => NON_API_FOLDERS.has(segment)))
  const pathsIn = (...languages: readonly SourceLanguage[]): string[] => candidates.filter((path) => {
    const language = languageSpecFor(path)?.language
    return language !== undefined && languages.includes(language)
  })
  const [rust, ecmascript, python] = await Promise.all([
    rustSurface(repository, pathsIn(SourceLanguage.Rust)),
    ecmascriptSurface(repository, pathsIn(SourceLanguage.TypeScript, SourceLanguage.Tsx)),
    pythonSurface(repository, pathsIn(SourceLanguage.Python)),
  ])
  const go = goSurface(repository, pathsIn(SourceLanguage.Go))
  return (path, name) => rust(path, name) || ecmascript(path, name) || python(path, name) || go(path)
}

async function readTexts(repository: RepositoryFiles, paths: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths)]
  const blobs = await readBlobs(repository.repoDir, unique.map((path) => ({ commit: repository.commit, path })))
  return new Map(unique.flatMap((path, index) => {
    const blob = blobs.at(index)
    return blob === undefined ? [] : [[path, blob.toString("utf8")] as const]
  }))
}

/** The folder of the nearest file with one of `names`, walking up from `path`, with a trailing slash. */
function nearestManifest(paths: ReadonlySet<string>, path: string, names: readonly string[]): string | undefined {
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    const prefix = folder === "." ? "" : `${folder}/`
    const name = names.find((candidate) => paths.has(`${prefix}${candidate}`))
    if (name !== undefined) return `${prefix}${name}`
    if (folder === ".") return undefined
  }
}

// --- Rust: a `pub` item is API when its crate has a library target and every module up to the root is `pub`.

const CARGO_MANIFEST = "Cargo.toml"
const CARGO_PUBLISHED_NEVER = /^\s*publish\s*=\s*false/m
const PUB_MOD = /\bpub\s+mod\s+(\w+)/g
const PUB_USE = /\bpub\s+use\s+([^;]+);/g
const USE_TOKEN = /\w+|\*/g

interface ModuleStep {
  readonly module: string
  /** The files that may declare this module; a parent is either `a.rs` or `a/mod.rs`. */
  readonly parents: readonly string[]
}

function moduleSteps(source: string, relative: string): ModuleStep[] {
  const segments = relative.replace(/\.rs$/, "").split("/").filter((segment, index, all) => !(segment === "mod" && index === all.length - 1))
  return segments.map((module, index) => {
    const ancestors = segments.slice(0, index).join("/")
    return { module, parents: index === 0 ? [`${source}lib.rs`] : [`${source}${ancestors}.rs`, `${source}${ancestors}/mod.rs`] }
  })
}

function isExposedBy(parentText: string, step: ModuleStep, name: string): boolean {
  if (Array.from(parentText.matchAll(PUB_MOD), (match) => match[1]).includes(step.module)) return true
  return Array.from(parentText.matchAll(PUB_USE), (match) => match[1] ?? "").some((use) => {
    const tokens = new Set(use.match(USE_TOKEN))
    return tokens.has(step.module) && (tokens.has("*") || tokens.has(name))
  })
}

async function rustSurface(repository: RepositoryFiles, paths: readonly string[]): Promise<LibrarySurface> {
  const manifestOf = new Map(paths.flatMap((path) => {
    const manifest = nearestManifest(repository.paths, path, [CARGO_MANIFEST])
    return manifest === undefined ? [] : [[path, manifest] as const]
  }))
  const stepsOf = new Map([...manifestOf].flatMap(([path, manifest]) => {
    const source = `${manifest.slice(0, -CARGO_MANIFEST.length)}src/`
    return path.startsWith(source) && repository.paths.has(`${source}lib.rs`) ? [[path, moduleSteps(source, path.slice(source.length))] as const] : []
  }))
  const texts = await readTexts(repository, [...manifestOf.values(), ...[...stepsOf.values()].flat().flatMap((step) => step.parents)])
  return (path, name) => {
    const steps = stepsOf.get(path)
    const manifest = texts.get(manifestOf.get(path) ?? "")
    if (steps === undefined || manifest === undefined || CARGO_PUBLISHED_NEVER.test(manifest)) return false
    return steps.every((step) => step.parents.some((parent) => isExposedBy(texts.get(parent) ?? "", step, name)))
  }
}

// --- TypeScript and JavaScript: an `export` is API when a published package's entry point re-exports it.

const PACKAGE_MANIFEST = "package.json"
const packageManifestSchema = z.object({
  private: z.boolean().optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  types: z.string().optional(),
  typings: z.string().optional(),
  exports: z.unknown().optional(),
})
const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]
const CODE_EXTENSION = /\.(d\.ts|d\.mts|mts|cts|ts|tsx|mjs|cjs|js|jsx)$/
// Where builds usually write; published entry points name these, and the source sits under `src`.
const BUILD_FOLDERS = /^(?:\.\/)?(?:(?:dist|lib|build|out|esm|cjs|es|types)\/)+/
const EXPORT_ALL = /\bexport\s+\*(?:\s+as\s+\w+)?\s+from\s+["'](\.[^"']+)["']/g
const EXPORT_NAMES = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s+["'](\.[^"']+)["']/g

type ExposedNames = "all" | ReadonlySet<string>

function parseManifest(text: string | undefined): z.infer<typeof packageManifestSchema> | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return packageManifestSchema.safeParse(parsed).data
  } catch {
    // A manifest that doesn't parse says nothing about what the package publishes.
    return undefined
  }
}

function stringsWithin(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (typeof value !== "object" || value === null) return []
  return Object.values(value).flatMap(stringsWithin)
}

function entrySources(paths: ReadonlySet<string>, folder: string, entries: readonly string[]): string[] {
  const stems = entries.flatMap((entry) => {
    const stem = entry.replace(/^\.\//, "").replace(CODE_EXTENSION, "")
    return [stem, stem.replace(BUILD_FOLDERS, "src/")]
  })
  return stems.flatMap((stem) => SOURCE_EXTENSIONS.map((extension) => `${folder}${stem}${extension}`)).filter((path) => paths.has(path))
}

function resolveRelative(paths: ReadonlySet<string>, from: string, specifier: string): string | undefined {
  const stem = posix.join(posix.dirname(from), specifier).replace(CODE_EXTENSION, "")
  return [...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => `${stem}/index${extension}`)].find((path) => paths.has(path))
}

function namesFromClause(clause: string): string[] {
  return clause.split(",").flatMap((specifier) => specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(0) || [])
}

function reexportsOf(paths: ReadonlySet<string>, from: string, text: string): [string, ExposedNames][] {
  const all = Array.from(text.matchAll(EXPORT_ALL), (match): [string | undefined, ExposedNames] => [resolveRelative(paths, from, match[1] ?? ""), "all"])
  const named = Array.from(text.matchAll(EXPORT_NAMES), (match): [string | undefined, ExposedNames] => [resolveRelative(paths, from, match[2] ?? ""), new Set(namesFromClause(match[1] ?? ""))])
  return [...all, ...named].flatMap(([path, names]) => (path === undefined ? [] : [[path, names]]))
}

function widerNames(a: ExposedNames | undefined, b: ExposedNames): ExposedNames {
  if (a === undefined) return b
  return a === "all" || b === "all" ? "all" : new Set([...a, ...b])
}

/** Follows `export ... from` from the entry points, recording which names each file exposes. */
async function followReexports(repository: RepositoryFiles, entries: readonly string[]): Promise<Map<string, ExposedNames>> {
  const exposed = new Map<string, ExposedNames>(entries.map((entry) => [entry, "all"]))
  let frontier = [...exposed.keys()]
  const visited = new Set<string>()
  while (frontier.length > 0 && visited.size < MAX_REEXPORT_FILES) {
    frontier.forEach((path) => visited.add(path))
    const texts = await readTexts(repository, frontier)
    const next = new Set<string>()
    for (const [from, text] of texts) {
      for (const [path, names] of reexportsOf(repository.paths, from, text)) {
        exposed.set(path, widerNames(exposed.get(path), names))
        if (!visited.has(path)) next.add(path)
      }
    }
    frontier = [...next]
  }
  return exposed
}

async function ecmascriptSurface(repository: RepositoryFiles, paths: readonly string[]): Promise<LibrarySurface> {
  const manifestPaths = [...new Set(paths.flatMap((path) => nearestManifest(repository.paths, path, [PACKAGE_MANIFEST]) ?? []))]
  const manifests = await readTexts(repository, manifestPaths)
  const entries = [...manifests].flatMap(([path, text]) => {
    const manifest = parseManifest(text)
    if (manifest === undefined || manifest.private === true) return []
    const declared = [manifest.main, manifest.module, manifest.types, manifest.typings, ...stringsWithin(manifest.exports)].flatMap((entry) => entry ?? [])
    // Node falls back to index.js when a package names no entry point.
    return entrySources(repository.paths, path.slice(0, -PACKAGE_MANIFEST.length), declared.length > 0 ? declared : ["index.js"])
  })
  const exposed = await followReexports(repository, entries)
  return (path, name) => {
    const names = exposed.get(path)
    return names === "all" || names?.has(name) === true
  }
}

// --- Python: every module of an installable project is importable unless its name says otherwise.

const PYTHON_MANIFESTS: readonly string[] = ["pyproject.toml", "setup.py", "setup.cfg"]
// A pyproject.toml without a build backend describes an application's tools, not something to install.
const PYPROJECT_BUILDS = /^\[build-system\]/m
const DUNDER_ALL = /^__all__\s*(?::[^=\n]+)?=\s*[[(]([^\])]*)[\])]/m
const QUOTED_NAME = /["'](\w+)["']/g
const PACKAGE_INIT = "__init__"
const RELATIVE_IMPORT = /^\s*from\s+\.(\w+)\s+import\s+(\([^)]*\)|[^\n]+)/gm

function isPrivateName(segment: string): boolean {
  return segment.startsWith("_") && segment !== PACKAGE_INIT
}

function packageInitOf(path: string): string {
  return posix.join(posix.dirname(path), `${PACKAGE_INIT}.py`)
}

/**
 * Many libraries keep everything in `_x.py` and publish it from the package: `from ._x import *`.
 * Only that one step is followed. A private module inside a private package stays private.
 */
function isReexportedByPackage(path: string, name: string, packageInit: string | undefined): boolean {
  const moduleName = posix.basename(path).replace(/\.pyi?$/, "")
  if (packageInit === undefined || posix.dirname(path).split("/").some(isPrivateName)) return false
  return Array.from(packageInit.matchAll(RELATIVE_IMPORT)).some((match) => {
    const imported = new Set(match[2]?.match(USE_TOKEN))
    return match[1] === moduleName && (imported.has("*") || imported.has(name))
  })
}

function isPrivateModulePath(path: string): boolean {
  return path.replace(/\.pyi?$/, "").split("/").some(isPrivateName)
}

function listedInDunderAll(text: string | undefined, name: string): boolean {
  const listed = DUNDER_ALL.exec(text ?? "")?.[1]
  return listed === undefined || Array.from(listed.matchAll(QUOTED_NAME), (match) => match[1]).includes(name)
}

async function pythonSurface(repository: RepositoryFiles, paths: readonly string[]): Promise<LibrarySurface> {
  const manifestOf = new Map(paths.flatMap((path) => {
    const manifest = nearestManifest(repository.paths, path, PYTHON_MANIFESTS)
    return manifest === undefined ? [] : [[path, manifest] as const]
  }))
  const texts = await readTexts(repository, [...manifestOf.values(), ...manifestOf.keys(), ...[...manifestOf.keys()].map(packageInitOf)])
  return (path, name) => {
    const manifest = manifestOf.get(path)
    if (manifest === undefined || (isPrivateModulePath(path) && !isReexportedByPackage(path, name, texts.get(packageInitOf(path))))) return false
    const installable = !manifest.endsWith("pyproject.toml") || PYPROJECT_BUILDS.test(texts.get(manifest) ?? "")
    return installable && listedInDunderAll(texts.get(path), name)
  }
}

// --- Go: an exported name is API when its package is part of a module and isn't `internal`.
// Whether a name is exported, and whether the package is `main`, is the language spec's to say.

const GO_MODULE_MANIFEST = "go.mod"
// The Go toolchain refuses imports of an `internal` package from outside the tree its parent roots.
const GO_INTERNAL_FOLDER = "internal"
const GO_TEST_FILE = /_test\.go$/

function goSurface(repository: RepositoryFiles, paths: readonly string[]): (path: string) => boolean {
  const importable = new Set(paths.filter((path) =>
    !GO_TEST_FILE.test(path) &&
    !path.split("/").includes(GO_INTERNAL_FOLDER) &&
    nearestManifest(repository.paths, path, [GO_MODULE_MANIFEST]) !== undefined,
  ))
  return (path) => importable.has(path)
}
