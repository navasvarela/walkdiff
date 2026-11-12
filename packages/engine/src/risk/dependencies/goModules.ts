import { Ecosystem } from "./ecosystem.ts"
import type { DeclaredDependencies, PackageVersion } from "./ecosystem.ts"

// go.mod reference: https://go.dev/ref/mod#go-mod-file

interface Requirement {
  readonly module: string
  readonly version: string
  /** Marked `// indirect`: needed by a dependency, not imported by this module's own code. */
  readonly indirect: boolean
}

type Replacement = { readonly kind: "directory"; readonly path: string } | { readonly kind: "module"; readonly module: string; readonly version: string }

interface GoMod {
  readonly requirements: readonly Requirement[]
  /** Keyed by the module, or by `module@version` when the directive names one version. */
  readonly replacements: ReadonlyMap<string, Replacement>
}

const INDIRECT_COMMENT = /\/\/\s*indirect\b/
const LINE_COMMENT = /\/\/.*$/
// `./x`, `../x`, `/abs` and Windows' `C:\x` are directories; anything else names a module.
const DIRECTORY_PATH = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/
const BLOCK_END = ")"

/** Direct requirements, the ones the module's own code imports; a module replaced by a directory isn't fetched. */
export function parseGoMod(text: string): DeclaredDependencies {
  const { requirements, replacements } = readGoMod(text)
  const declared = new Map<string, string>()
  for (const requirement of requirements) {
    if (requirement.indirect) continue
    const replacement = replacementFor(replacements, requirement)
    declared.set(requirement.module, replacement?.kind === "directory" ? `path:${replacement.path}` : requirement.version)
  }
  return declared
}

/** Every module version the build uses, replacements applied. */
export function goModLockfile(text: string): PackageVersion[] {
  const { requirements, replacements } = readGoMod(text)
  return requirements.flatMap((requirement) => {
    const replacement = replacementFor(replacements, requirement)
    if (replacement?.kind === "directory") return []
    const used = replacement ?? requirement
    return [{ ecosystem: Ecosystem.Go, name: used.module, version: used.version }]
  })
}

function replacementFor(replacements: ReadonlyMap<string, Replacement>, requirement: Requirement): Replacement | undefined {
  return replacements.get(`${requirement.module}@${requirement.version}`) ?? replacements.get(requirement.module)
}

function readGoMod(text: string): GoMod {
  const requirements: Requirement[] = []
  const replacements = new Map<string, Replacement>()
  let block: string | undefined
  for (const rawLine of text.split("\n")) {
    const indirect = INDIRECT_COMMENT.test(rawLine)
    const line = rawLine.replace(LINE_COMMENT, "").trim()
    if (line === "") continue
    if (block !== undefined && line === BLOCK_END) {
      block = undefined
      continue
    }
    const words = line.split(/\s+/)
    // `require (` opens a block whose lines leave out the directive; `require a v1` is one line.
    const [directive, rest] = block === undefined ? [words.at(0), words.slice(1)] : [block, words]
    if (block === undefined && rest.length === 1 && rest.at(0) === "(") {
      block = directive
      continue
    }
    if (directive === "require") addRequirement(requirements, rest, indirect)
    if (directive === "replace") addReplacement(replacements, rest)
  }
  return { requirements, replacements }
}

function addRequirement(requirements: Requirement[], words: readonly string[], indirect: boolean): void {
  const [module, version] = words
  if (module !== undefined && version !== undefined) requirements.push({ module: unquote(module), version, indirect })
}

// `old [v1] => new [v2]`: the new side is a directory, or a module with a version.
function addReplacement(replacements: Map<string, Replacement>, words: readonly string[]): void {
  const arrow = words.indexOf("=>")
  const [module, version] = words.slice(0, arrow)
  const [target, targetVersion] = words.slice(arrow + 1)
  if (arrow === -1 || module === undefined || target === undefined) return
  const key = version === undefined ? unquote(module) : `${unquote(module)}@${version}`
  const path = unquote(target)
  if (DIRECTORY_PATH.test(path)) replacements.set(key, { kind: "directory", path })
  else if (targetVersion !== undefined) replacements.set(key, { kind: "module", module: path, version: targetVersion })
}

// Module paths may be quoted, as "example.com/m" or `example.com/m`.
function unquote(word: string): string {
  return word.replace(/^["`]|["`]$/g, "")
}
