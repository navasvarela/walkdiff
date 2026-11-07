import { isMap, isPair, isScalar, isSeq, LineCounter, parseAllDocuments } from "yaml"
import type { Node, Pair } from "yaml"

/** Text from the file with the line it starts on, counted from 1. */
export interface LocatedText {
  readonly text: string
  readonly line: number
}

export const IncludeKind = { Local: "local", Remote: "remote", Project: "project", Component: "component", Template: "template" } as const
export type IncludeKind = (typeof IncludeKind)[keyof typeof IncludeKind]

export type GitlabInclude =
  | { readonly kind: typeof IncludeKind.Local; readonly path: string; readonly line: number }
  | { readonly kind: typeof IncludeKind.Remote; readonly url: string; readonly hasIntegrity: boolean; readonly line: number }
  | { readonly kind: typeof IncludeKind.Project; readonly project: string; readonly ref: string | undefined; readonly line: number }
  | { readonly kind: typeof IncludeKind.Component; readonly component: string; readonly line: number }
  | { readonly kind: typeof IncludeKind.Template; readonly line: number }

/** What Walkdiff's rules and include resolution need from one GitLab CI file. */
export interface GitlabCiConfig {
  readonly includes: readonly GitlabInclude[]
  /** `image` and `services` entries, by name. */
  readonly images: readonly LocatedText[]
  /** Every source line of `script`, `before_script` and `after_script` entries. */
  readonly scriptLines: readonly LocatedText[]
}

const SCRIPT_KEYS: ReadonlySet<string> = new Set(["script", "before_script", "after_script"])
// Values under these keys are data, not jobs: a variable or an input called `image` isn't one.
const DATA_KEYS: ReadonlySet<string> = new Set(["variables", "spec", "inputs"])
const REMOTE_URL = /^https?:/

/**
 * Reads a GitLab CI file without running it through GitLab's merge logic: anchors, `extends` and
 * `!reference` aren't resolved. Aliases are never expanded, so a file built to blow up when expanded
 * costs nothing. A file that isn't valid YAML gives whatever parsed before the error.
 */
export function parseGitlabCi(text: string): GitlabCiConfig {
  const lineCounter = new LineCounter()
  const reader = new ConfigReader(text, lineCounter)
  for (const document of parseAllDocuments(text, { lineCounter, uniqueKeys: false })) {
    if (!isMap(document.contents)) continue
    for (const pair of document.contents.items) {
      if (keyOf(pair) === "include") reader.readIncludes(pair.value)
    }
    reader.walk(document.contents)
  }
  return { includes: reader.includes, images: reader.images, scriptLines: reader.scriptLines }
}

class ConfigReader {
  readonly includes: GitlabInclude[] = []
  readonly images: LocatedText[] = []
  readonly scriptLines: LocatedText[] = []
  readonly #text: string
  readonly #lineCounter: LineCounter

  constructor(text: string, lineCounter: LineCounter) {
    this.#text = text
    this.#lineCounter = lineCounter
  }

  walk(node: unknown): void {
    if (isSeq(node)) {
      for (const item of node.items) this.walk(item)
      return
    }
    if (!isMap(node)) return
    for (const pair of node.items) {
      const key = keyOf(pair)
      if (key === undefined || DATA_KEYS.has(key) || key === "include") continue
      if (SCRIPT_KEYS.has(key)) this.#readScript(pair.value)
      else if (key === "image") this.#readImage(pair.value)
      else if (key === "services" && isSeq(pair.value)) for (const service of pair.value.items) this.#readImage(service)
      else this.walk(pair.value)
    }
  }

  readIncludes(node: unknown): void {
    const items = isSeq(node) ? node.items : [node]
    for (const item of items) {
      const include = this.#includeOf(item)
      if (include !== undefined) this.includes.push(include)
    }
  }

  #includeOf(item: unknown): GitlabInclude | undefined {
    if (isScalar(item) && typeof item.value === "string") {
      const line = this.#lineOf(item)
      return REMOTE_URL.test(item.value) ? { kind: IncludeKind.Remote, url: item.value, hasIntegrity: false, line } : { kind: IncludeKind.Local, path: item.value, line }
    }
    if (!isMap(item)) return undefined
    const line = this.#lineOf(item)
    const field = (name: string): string | undefined => {
      const value = item.get(name)
      return typeof value === "string" ? value : undefined
    }
    const local = field("local")
    if (local !== undefined) return { kind: IncludeKind.Local, path: local, line }
    const remote = field("remote")
    if (remote !== undefined) return { kind: IncludeKind.Remote, url: remote, hasIntegrity: field("integrity") !== undefined, line }
    const project = field("project")
    if (project !== undefined) return { kind: IncludeKind.Project, project, ref: field("ref"), line }
    const component = field("component")
    if (component !== undefined) return { kind: IncludeKind.Component, component, line }
    return field("template") === undefined ? undefined : { kind: IncludeKind.Template, line }
  }

  #readScript(node: unknown): void {
    if (isSeq(node)) {
      for (const item of node.items) this.#readScript(item)
      return
    }
    if (!isScalar(node) || node.range === undefined || node.range === null) return
    // The source, not the parsed value: it keeps each line of a block scalar where the reader sees it.
    const [start, end] = node.range
    const first = this.#lineCounter.linePos(start).line
    this.#text.slice(start, end).split("\n").forEach((text, offset) => this.scriptLines.push({ text, line: first + offset }))
  }

  #readImage(node: unknown): void {
    const name = isMap(node) ? node.get("name", true) : node
    if (isScalar(name) && typeof name.value === "string") this.images.push({ text: name.value, line: this.#lineOf(name) })
  }

  #lineOf(node: Node): number {
    return this.#lineCounter.linePos(node.range?.[0] ?? 0).line
  }
}

function keyOf(pair: Pair<unknown, unknown>): string | undefined {
  return isPair(pair) && isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : undefined
}
