import { changedUnitsOf, isTestPath, isTestUnit, UnitChangeKind } from "@walkdiff/review-model"
import type { ChangedFile, ChangedUnit, UnitSnapshot } from "@walkdiff/review-model"

/** A changed function whose doc comment lists parameters it no longer has, or misses ones it gained. */
export interface ParameterDrift {
  readonly path: string
  readonly line: number
  readonly unit: string
  /** Documented, but no longer a parameter. */
  readonly stale: readonly string[]
  /** New parameters the doc comment doesn't describe, though it describes others. */
  readonly missing: readonly string[]
}

// `@param name`, `@param {Type} name`, `@param [name]`: JSDoc, Javadoc, KDoc and PHPDoc.
const AT_PARAM = /@param\s+(?:\{[^}]*\}\s+)?\[?\$?([A-Za-z_$][\w$]*)/g
// reST and Sphinx: `:param name:` or `:param int name:`.
const REST_PARAM = /:param\s+(?:[\w[\], .]+\s+)?([A-Za-z_]\w*)\s*:/g
// Google-style Python sections, and Markdown headings such as Rust's `# Arguments`.
const SECTION_HEADER = /^(\s*)(#+\s*)?(?:Args|Arguments|Parameters|Keyword Args|Keyword Arguments)\s*:?\s*$/
// Rust writes its doc comments as `///` or `//!` lines, with Markdown inside.
const LINE_DOC_PREFIX = /^\s*\/\/[/!] ?/
// NumPy style underlines its section title: `Parameters` then `----------`.
const UNDERLINE = /^\s*-{3,}\s*$/
// An entry in a section: `name (int): …`, `name: …`, `**kwargs: …`, `name : int`, or Rust's `` * `name` - … ``.
const SECTION_ENTRY = /^\s*(?:[*-]\s+`)?\*{0,2}([A-Za-z_]\w*)`?\s*(?:\([^)]*\))?\s*[:-]/
// Parameter names as the engine records them can carry the language's markers: `*args`, `&self`, `$x`.
const NAME_MARKERS = /^[*&$.]+/
const RECEIVERS: ReadonlySet<string> = new Set(["self", "cls", "this"])

/**
 * Doc comments that no longer match their function's parameters, in functions the PR changed.
 * Only parameters the PR added or removed are compared: a doc comment that was already out of
 * date isn't this PR's doing.
 */
export function parameterDrift(files: readonly ChangedFile[]): ParameterDrift[] {
  return files
    .filter((file) => !isTestPath(file.diff.path))
    .flatMap((file) => changedUnitsOf(file).flatMap((unit) => driftIn(file.diff.path, unit)))
}

function driftIn(path: string, unit: ChangedUnit): ParameterDrift[] {
  const after = snapshotAfter(unit)
  const facts = unit.facts
  if (after === undefined || facts === null || isTestUnit(unit)) return []
  const documented = documentedParameters(after.text)
  if (documented.size === 0) return []
  const stale = facts.parametersRemoved.map(plainName).filter((name) => documented.has(name))
  const missing = facts.parametersAdded.map(plainName).filter((name) => !documented.has(name) && !RECEIVERS.has(name))
  return stale.length === 0 && missing.length === 0 ? [] : [{ path, line: after.startLine, unit: unit.qualifiedName, stale, missing }]
}

function snapshotAfter(unit: ChangedUnit): UnitSnapshot | undefined {
  switch (unit.change.kind) {
    case UnitChangeKind.Modified:
    case UnitChangeKind.Renamed:
    case UnitChangeKind.MovedIn:
      return unit.change.after
    case UnitChangeKind.Added:
    case UnitChangeKind.Removed:
    case UnitChangeKind.MovedOut:
      return undefined
  }
}

function plainName(name: string): string {
  return name.replace(NAME_MARKERS, "")
}

/** The parameter names a function's doc comment describes, in any of the common styles. */
export function documentedParameters(text: string): Set<string> {
  const names = new Set([...text.matchAll(AT_PARAM), ...text.matchAll(REST_PARAM)].map((match) => match[1] ?? ""))
  const lines = text.split("\n").map((line) => line.replace(LINE_DOC_PREFIX, ""))
  lines.forEach((line, index) => {
    const header = SECTION_HEADER.exec(line)
    if (header === null) return
    const underlined = UNDERLINE.test(lines.at(index + 1) ?? "")
    // A Markdown heading's list sits level with it, often after a blank line, as an underlined title's does.
    const markdown = header[2] !== undefined
    const body = lines.slice(index + (underlined ? 2 : 1))
    const start = markdown ? body.findIndex((entry) => entry.trim() !== "") : 0
    for (const name of sectionEntries(body.slice(Math.max(start, 0)), (header[1] ?? "").length, underlined || markdown)) names.add(name)
  })
  names.delete("")
  return names
}

/**
 * Entries of a section, which ends at a blank line, the next title, or a line less indented than
 * its header. Entries all share one indent: Google style indents them under the header and NumPy
 * style keeps them level with it. Their descriptions sit deeper, and can contain colons.
 */
function sectionEntries(lines: readonly string[], headerIndent: number, entriesLevel: boolean): string[] {
  const names: string[] = []
  let entryIndent: number | undefined = entriesLevel ? headerIndent : undefined
  for (const line of lines) {
    if (line.trim() === "" || SECTION_HEADER.test(line)) break
    const indent = line.length - line.trimStart().length
    if (indent < headerIndent || (!entriesLevel && indent === headerIndent)) break
    entryIndent ??= indent
    const name = indent === entryIndent ? SECTION_ENTRY.exec(line)?.[1] : undefined
    if (name !== undefined) names.push(name)
  }
  return names
}
