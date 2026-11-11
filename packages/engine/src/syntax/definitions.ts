import { createHash } from "node:crypto"
import { UnitKind } from "@walkdiff/review-model"
import type { UnitSnapshot } from "@walkdiff/review-model"
import type { Node, Tree } from "web-tree-sitter"
import type { ContainerContext, DefinitionHeader, LanguageSpec, PublicDefinitionTest } from "./languageSpec.ts"
import { extractShape } from "./shape.ts"
import type { UnitShape } from "./shape.ts"

/**
 * Hashes of a unit's token stream at several levels of strictness. Comparing them tells
 * a semantic change from a comment-only or formatting-only one without diffing text.
 */
export interface Fingerprints {
  /** Code tokens only: equal when two versions differ at most in whitespace and comments. */
  readonly code: string
  /** Code and comment tokens: equal when two versions differ at most in whitespace. */
  readonly full: string
  /** Like `code` and `full`, but leaving out nested units, which are compared on their own. */
  readonly ownCode: string
  readonly ownFull: string
  /** `code` with the unit's own name masked, to recognise renames. */
  readonly nameAgnosticCode: string
}

export interface Definition {
  readonly kind: UnitKind
  readonly name: string
  readonly qualifiedName: string
  /** Matches the same definition across the two versions of a file; unique within a file. */
  readonly key: string
  readonly parentKey: string | undefined
  readonly hasChildren: boolean
  /** By the language's own rules and its container's; a library may still not expose its file. */
  readonly isPublic: boolean
  /** Nested units collapsed to their first line, for when each changed one is shown on its own. */
  readonly snapshot: UnitSnapshot
  /**
   * Nested units written out, for when the unit is shown alone: added, removed, renamed or moved
   * with everything in it, so nothing else shows what it holds. The same as `snapshot` without
   * nested units.
   */
  readonly wholeSnapshot: UnitSnapshot
  /** Code tokens in order, without comments, to tell how alike two versions are when their fingerprints differ. */
  readonly codeTokens: readonly string[]
  readonly fingerprints: Fingerprints
  /** Parameters, calls and control flow; undefined for anything but functions and methods. */
  readonly shape: UnitShape | undefined
}

export interface ModuleScope {
  readonly snapshot: UnitSnapshot
  /** False when the file is nothing but definitions (no imports, statements or comments). */
  readonly hasOwnTokens: boolean
  readonly ownCode: string
  readonly ownFull: string
}

export interface FileUnits {
  /** Every definition in the file, parents before their children. */
  readonly definitions: readonly Definition[]
  readonly moduleScope: ModuleScope
}

export const MODULE_SCOPE_NAME = "(module scope)"
// Appended to a nested unit's first line where the rest of it is collapsed.
const ELISION_MARKER = "⋯"
const TOKEN_SEPARATOR = "\u0001"
const MASKED_NAME = "\u0000name"
const CLOSING_BRACKETS: ReadonlySet<string> = new Set([")", "]", "}", ">"])
// Test titles are sentences, so "parser › reads includes" reads better than "parser.reads includes".
const TEST_TITLE_SEPARATOR = " › "

interface Span {
  readonly start: number
  readonly end: number
}

interface Token {
  readonly text: string
  readonly comment: boolean
  readonly isName: boolean
}

interface RawDefinition {
  readonly header: DefinitionHeader
  /** The node that defines the unit, without attached prefixes and wrappers. */
  readonly node: Node
  /** First to last node of the definition, attached prefixes and wrappers included. */
  readonly nodes: readonly Node[]
  readonly span: Span
  /** Row of the definition's own first line, below any attached comments or attributes. */
  readonly headerRow: number
  readonly qualifiedName: string
  readonly key: string
  readonly parentKey: string | undefined
  readonly isPublic: boolean
  readonly children: RawDefinition[]
}

/** Extracts the file's units. Must run inside `withSyntaxTree`: it reads nodes of a live tree. */
export function extractUnits(spec: LanguageSpec, tree: Tree, source: string): FileUnits {
  const walker = new DefinitionWalker(spec, spec.publicDefinitions(tree.rootNode))
  const topLevel: RawDefinition[] = []
  walker.walk(tree.rootNode, undefined, undefined, topLevel)

  const lines = source.split("\n")
  const definitions: Definition[] = []
  const flatten = (raw: RawDefinition): void => {
    definitions.push(toDefinition(spec, raw, lines))
    raw.children.forEach(flatten)
  }
  topLevel.forEach(flatten)

  return { definitions, moduleScope: toModuleScope(spec, tree.rootNode, topLevel, lines) }
}

class DefinitionWalker {
  readonly #spec: LanguageSpec
  readonly #isPublic: PublicDefinitionTest
  readonly #keyCounts = new Map<string, number>()

  constructor(spec: LanguageSpec, isPublic: PublicDefinitionTest) {
    this.#spec = spec
    this.#isPublic = isPublic
  }

  walk(node: Node, container: ContainerContext | undefined, parentKey: string | undefined, out: RawDefinition[]): void {
    for (const child of node.namedChildren) {
      if (child === null) continue
      const header = this.#spec.describe(child, container)
      if (header !== undefined) {
        const definition = this.#define(child, header, container, parentKey)
        out.push(definition)
        if (this.#spec.isContainer(header.kind)) {
          const childPrefix = this.#spec.childPrefix(header, child, definition.qualifiedName)
          this.walk(child, { kind: header.kind, childPrefix, isPublic: definition.isPublic }, definition.key, definition.children)
        }
      } else if (!this.#spec.isOpaque(child)) {
        this.walk(child, container, parentKey, out)
      }
    }
  }

  #define(
    node: Node,
    header: DefinitionHeader,
    container: ContainerContext | undefined,
    parentKey: string | undefined,
  ): RawDefinition {
    const outer = this.#spec.outerNode(node)
    const nodes = [...this.#attachedPrefix(outer), outer]
    const first = nodes.at(0) ?? outer
    const separator = container?.kind === UnitKind.TestSuite ? TEST_TITLE_SEPARATOR : this.#spec.separator
    // C++'s `void Server::start()` inside `namespace net` is `net::Server::start`.
    const prefix = [container?.childPrefix, header.owner].filter((part) => part !== undefined).join(this.#spec.separator)
    const qualifiedName = prefix === "" ? header.name : `${prefix}${separator}${header.name}`
    return {
      header,
      node,
      nodes,
      span: { start: first.startIndex, end: outer.endIndex },
      headerRow: node.startPosition.row,
      qualifiedName,
      key: this.#uniqueKey(`${qualifiedName}|${header.kind}`),
      parentKey,
      isPublic: container?.isPublic !== false && this.#isPublic(node, header.name, container),
      children: [],
    }
  }

  // Comments, attributes and decorators on the lines directly above a definition belong to it.
  #attachedPrefix(outer: Node): Node[] {
    const prefix: Node[] = []
    let first = outer
    let previous = outer.previousNamedSibling
    while (
      previous !== null &&
      (isComment(previous) || this.#spec.isAttachedPrefix(previous)) &&
      previous.endPosition.row >= first.startPosition.row - 1
    ) {
      prefix.unshift(previous)
      first = previous
      previous = previous.previousNamedSibling
    }
    return prefix
  }

  // Overloads and repeated `impl Foo` blocks share a name; the occurrence index tells them apart.
  #uniqueKey(base: string): string {
    const seen = this.#keyCounts.get(base) ?? 0
    this.#keyCounts.set(base, seen + 1)
    return seen === 0 ? base : `${base}#${seen}`
  }
}

function toDefinition(spec: LanguageSpec, raw: RawDefinition, lines: readonly string[]): Definition {
  const nameNode = raw.header.nameNode
  const nameSpan = nameNode === null ? undefined : { start: nameNode.startIndex, end: nameNode.endIndex }
  const all = normalizeTrailingCommas(collectTokens(spec, raw.nodes, [], nameSpan))
  const own = normalizeTrailingCommas(collectTokens(spec, raw.nodes, raw.children.map((child) => child.span), undefined))
  const code = all.filter((token) => !token.comment)

  const first = raw.nodes.at(0)
  const last = raw.nodes.at(-1)
  const startLine = (first?.startPosition.row ?? 0) + 1
  const endLine = (last?.endPosition.row ?? 0) + 1
  return {
    kind: raw.header.kind,
    name: raw.header.name,
    qualifiedName: raw.qualifiedName,
    key: raw.key,
    parentKey: raw.parentKey,
    hasChildren: raw.children.length > 0,
    isPublic: raw.isPublic,
    snapshot: {
      startLine,
      endLine,
      text: outline(lines, startLine - 1, endLine - 1, raw.children),
      elidesNestedUnits: raw.children.length > 0,
    },
    wholeSnapshot: { startLine, endLine, text: lines.slice(startLine - 1, endLine).join("\n"), elidesNestedUnits: false },
    codeTokens: code.map((token) => token.text),
    shape: raw.header.kind === UnitKind.Function || raw.header.kind === UnitKind.Method ? extractShape(spec.shape, raw.node) : undefined,
    fingerprints: {
      code: hashCode(code),
      full: hashFull(all),
      ownCode: hashCode(own.filter((token) => !token.comment)),
      ownFull: hashFull(own),
      nameAgnosticCode: hashTexts(code.map((token) => (token.isName ? MASKED_NAME : token.text))),
    },
  }
}

function toModuleScope(spec: LanguageSpec, root: Node, topLevel: readonly RawDefinition[], lines: readonly string[]): ModuleScope {
  const own = normalizeTrailingCommas(collectTokens(spec, [root], topLevel.map((definition) => definition.span), undefined))
  return {
    snapshot: {
      startLine: 1,
      endLine: Math.max(lines.length, 1),
      text: outline(lines, 0, lines.length - 1, topLevel),
      elidesNestedUnits: true,
    },
    hasOwnTokens: own.length > 0,
    ownCode: hashCode(own.filter((token) => !token.comment)),
    ownFull: hashFull(own),
  }
}

/** The lines from `firstRow` to `lastRow`, each nested unit collapsed to its first line. */
function outline(lines: readonly string[], firstRow: number, lastRow: number, nested: readonly RawDefinition[]): string {
  const kept: string[] = []
  let row = firstRow
  for (const definition of nested) {
    const nestedFirstRow = definition.nodes.at(0)?.startPosition.row ?? definition.headerRow
    const nestedLastRow = definition.nodes.at(-1)?.endPosition.row ?? definition.headerRow
    kept.push(...lines.slice(row, nestedFirstRow))
    kept.push(`${(lines.at(definition.headerRow) ?? "").trimEnd()} ${ELISION_MARKER}`)
    row = Math.max(row, nestedLastRow + 1)
  }
  kept.push(...lines.slice(row, lastRow + 1))
  return kept.join("\n")
}

/**
 * Collects leaf tokens under `nodes`, skipping subtrees inside `excluded` spans. A comment
 * is one token however the grammar splits it, so doc-comment markup cannot leak into code.
 */
function collectTokens(
  spec: LanguageSpec,
  nodes: readonly Node[],
  excluded: readonly Span[],
  nameSpan: Span | undefined,
): Token[] {
  const tokens: Token[] = []
  const visit = (node: Node): void => {
    if (excluded.some((span) => node.startIndex >= span.start && node.endIndex <= span.end)) {
      return
    }
    if (isComment(node)) {
      tokens.push({ text: node.text, comment: true, isName: false })
      return
    }
    if (node.childCount === 0) {
      // Zero-width leaves are tokens tree-sitter inserted to recover from a syntax error.
      if (node.endIndex > node.startIndex) {
        const isName = nameSpan !== undefined && node.startIndex === nameSpan.start && node.endIndex === nameSpan.end
        tokens.push({ text: spec.normalizeLeaf(node), comment: false, isName })
      }
      return
    }
    for (const child of node.children) {
      if (child !== null) visit(child)
    }
  }
  nodes.forEach(visit)
  return tokens
}

// Formatters add and remove trailing commas (`f(a, b,)`) without changing meaning.
// Walks backwards so each comma can see the next code token in constant time.
function normalizeTrailingCommas(tokens: readonly Token[]): Token[] {
  const kept: Token[] = []
  let nextCodeText: string | undefined
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens.at(index)
    if (token === undefined) continue
    const isTrailingComma =
      !token.comment && token.text === "," && nextCodeText !== undefined && CLOSING_BRACKETS.has(nextCodeText)
    if (isTrailingComma) continue
    kept.push(token)
    if (!token.comment) nextCodeText = token.text
  }
  return kept.reverse()
}

function isComment(node: Node): boolean {
  return node.type.includes("comment")
}

function hashCode(tokens: readonly Token[]): string {
  return hashTexts(tokens.map((token) => token.text))
}

function hashFull(tokens: readonly Token[]): string {
  return hashTexts(tokens.map((token) => `${token.comment ? "c" : "t"}${token.text}`))
}

function hashTexts(texts: readonly string[]): string {
  return createHash("sha1").update(texts.join(TOKEN_SEPARATOR)).digest("hex")
}
