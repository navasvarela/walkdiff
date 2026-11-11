/**
 * Syntax colouring for report code, from a small lexer of our own rather than a library or engine data.
 *
 * Measured on PR 3 (a 1.3 MB report), the options were:
 * - Prism adds 26 KB and highlight.js adds 42 KB. Both are regex driven, and crafted 100 KB lines
 *   froze them for 3 to 7 seconds. The text comes from the PR, so its author controls that.
 * - Sending tree-sitter tokens from the engine would be the most accurate, but adds about 137 KB to
 *   that report, and earlier snapshots saved in a reviewer's browser wouldn't have tokens.
 * - This lexer and its colours add 12 KB. Every step moves forward through the text, so its run
 *   time stays linear whatever the input. It only knows tokens, not grammar, so it can misjudge
 *   rare cases such as a generic arrow function in TSX. Those only ever cost a colour.
 */
import { C, CPP, createCStep } from "./c.ts"
import { goStep } from "./go.ts"
import { javaStep } from "./java.ts"
import { createJavaScriptStep, JAVASCRIPT, TSX, TYPESCRIPT } from "./javascript.ts"
import { pythonStep } from "./python.ts"
import { rustStep } from "./rust.ts"
import { Scanner } from "./scanner.ts"
import type { SyntaxKind, SyntaxSpan } from "./scanner.ts"

export const HighlightLanguage = { Rust: "rust", TypeScript: "typescript", Tsx: "tsx", JavaScript: "javascript", Python: "python", Go: "go", Java: "java", C: "c", Cpp: "cpp" } as const
export type HighlightLanguage = (typeof HighlightLanguage)[keyof typeof HighlightLanguage]

/** Spans of one line, with offsets relative to the start of that line. */
export type LineSpans = readonly SyntaxSpan[]

export interface TextRange {
  readonly start: number
  readonly end: number
}

export interface CodeSegment {
  readonly text: string
  readonly kind: SyntaxKind | undefined
  readonly marked: boolean
}

// Follows the engine's language table (`engine/src/syntax/languages.ts`), which the page can't import.
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, HighlightLanguage> = new Map([
  [".rs", HighlightLanguage.Rust],
  [".ts", HighlightLanguage.TypeScript],
  [".mts", HighlightLanguage.TypeScript],
  [".cts", HighlightLanguage.TypeScript],
  [".tsx", HighlightLanguage.Tsx],
  [".js", HighlightLanguage.JavaScript],
  [".mjs", HighlightLanguage.JavaScript],
  [".cjs", HighlightLanguage.JavaScript],
  [".jsx", HighlightLanguage.JavaScript],
  [".py", HighlightLanguage.Python],
  [".pyi", HighlightLanguage.Python],
  [".go", HighlightLanguage.Go],
  [".java", HighlightLanguage.Java],
  [".c", HighlightLanguage.C],
  // Headers may be C or C++; C++ colours a C header's code too, short of names such as `new`.
  [".h", HighlightLanguage.Cpp],
  [".cc", HighlightLanguage.Cpp],
  [".cpp", HighlightLanguage.Cpp],
  [".cxx", HighlightLanguage.Cpp],
  [".c++", HighlightLanguage.Cpp],
  [".hh", HighlightLanguage.Cpp],
  [".hpp", HighlightLanguage.Cpp],
  [".hxx", HighlightLanguage.Cpp],
  [".h++", HighlightLanguage.Cpp],
  [".inl", HighlightLanguage.Cpp],
  [".ipp", HighlightLanguage.Cpp],
  [".tpp", HighlightLanguage.Cpp],
])

const STEP_FACTORIES: Readonly<Record<HighlightLanguage, () => (scanner: Scanner) => void>> = {
  [HighlightLanguage.Rust]: () => rustStep,
  [HighlightLanguage.TypeScript]: () => createJavaScriptStep(TYPESCRIPT),
  [HighlightLanguage.Tsx]: () => createJavaScriptStep(TSX),
  [HighlightLanguage.JavaScript]: () => createJavaScriptStep(JAVASCRIPT),
  [HighlightLanguage.Python]: () => pythonStep,
  [HighlightLanguage.Go]: () => goStep,
  [HighlightLanguage.Java]: () => javaStep,
  [HighlightLanguage.C]: () => createCStep(C),
  [HighlightLanguage.Cpp]: () => createCStep(CPP),
}

/**
 * Lexing stays fast past these limits; what they protect is the page, since each coloured token
 * is a DOM node. 100,000 characters is about 3,000 lines, beyond what anyone reads token by token,
 * and a 2,000 character line is almost always minified or generated.
 */
export const MAX_HIGHLIGHT_CHARS = 100_000
export const MAX_HIGHLIGHT_LINE_CHARS = 2_000

export const NO_SPANS: LineSpans = []

export function languageForPath(path: string): HighlightLanguage | undefined {
  return LANGUAGE_BY_EXTENSION.get(path.slice(path.lastIndexOf(".")).toLowerCase())
}

/**
 * Colours a whole text at once and splits the result by line, because a comment or string can
 * span lines. Returns one entry per line, or none if the text stays plain. Callers read a line
 * with `.at(index) ?? NO_SPANS`.
 */
export function highlightLines(text: string, language: HighlightLanguage | undefined): readonly LineSpans[] {
  if (language === undefined || text.length > MAX_HIGHLIGHT_CHARS) return []
  return splitIntoLines(text, tokenize(text, language))
}

function tokenize(text: string, language: HighlightLanguage): readonly SyntaxSpan[] {
  const scanner = new Scanner(text)
  const step = STEP_FACTORIES[language]()
  while (scanner.pos < text.length) {
    const before = scanner.pos
    step(scanner)
    // The safety net behind the page never freezing: whatever a step did, the scan moves on.
    if (scanner.pos <= before) scanner.pos = before + 1
  }
  return scanner.spans
}

function splitIntoLines(text: string, spans: readonly SyntaxSpan[]): LineSpans[] {
  const lines: LineSpans[] = []
  let spanIndex = 0
  let lineStart = 0
  while (lineStart <= text.length) {
    const lineBreak = text.indexOf("\n", lineStart)
    const lineEnd = lineBreak === -1 ? text.length : lineBreak
    const line: SyntaxSpan[] = []
    while (spanIndex < spans.length) {
      const span = spans.at(spanIndex)
      if (span === undefined || span.start >= lineEnd) break
      const start = Math.max(span.start, lineStart)
      const end = Math.min(span.end, lineEnd)
      if (end > start) line.push({ start: start - lineStart, end: end - lineStart, kind: span.kind })
      if (span.end > lineEnd) break
      spanIndex++
    }
    lines.push(lineEnd - lineStart > MAX_HIGHLIGHT_LINE_CHARS ? NO_SPANS : line)
    lineStart = lineEnd + 1
  }
  return lines
}

/**
 * Cuts a line wherever its colour or edit mark changes, so one element can carry both: the
 * colour comes from the syntax and the background from the mark, and neither has to nest
 * inside the other when an edit ends in the middle of a token.
 */
export function segmentLine(text: string, spans: LineSpans, marks: readonly TextRange[]): CodeSegment[] {
  const segments: CodeSegment[] = []
  let spanIndex = 0
  let markIndex = 0
  let cursor = 0
  while (cursor < text.length) {
    while ((spans.at(spanIndex)?.end ?? Infinity) <= cursor) spanIndex++
    while ((marks.at(markIndex)?.end ?? Infinity) <= cursor) markIndex++
    const span = spans.at(spanIndex)
    const mark = marks.at(markIndex)
    const inSpan = span !== undefined && span.start <= cursor
    const inMark = mark !== undefined && mark.start <= cursor
    const next = Math.min(text.length, nextBoundary(span, inSpan), nextBoundary(mark, inMark))
    segments.push({ text: text.slice(cursor, next), kind: inSpan ? span.kind : undefined, marked: inMark })
    cursor = next
  }
  return segments
}

function nextBoundary(range: TextRange | undefined, isInside: boolean): number {
  if (range === undefined) return Infinity
  return isInside ? range.end : range.start
}
