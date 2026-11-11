import { LineBreaks, scanBlockComment, scanLineComment, scanQuoted, SyntaxKind, words } from "./scanner.ts"
import type { Scanner, Vocabulary } from "./scanner.ts"

const VOCABULARY: Vocabulary = {
  keywords: words(
    "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try void volatile while",
  ),
  // Newer keywords that older code can still use as names.
  contextualKeywords: words("var record yield sealed permits"),
  constants: words("true false null"),
  types: words("boolean byte char double float int long short"),
  functionDefiners: words(""),
}

const ANNOTATION = /@[\w.]+/y
const TEXT_BLOCK = '"""'

export function javaStep(scanner: Scanner): void {
  if (scanner.startsWith("//")) scanLineComment(scanner)
  else if (scanner.startsWith("/*")) scanBlockComment(scanner, "/*", "*/")
  else if (!scanToken(scanner)) scanner.pos++
}

function scanToken(scanner: Scanner): boolean {
  return (
    scanTextBlock(scanner) ||
    scanQuote(scanner, '"') ||
    scanQuote(scanner, "'") ||
    scanner.emitMatch(ANNOTATION, SyntaxKind.Meta) ||
    scanner.scanNumber() ||
    scanner.scanWord(VOCABULARY) !== undefined
  )
}

function scanTextBlock(scanner: Scanner): boolean {
  if (!scanner.startsWith(TEXT_BLOCK)) return false
  scanQuoted(scanner, TEXT_BLOCK.length, TEXT_BLOCK, LineBreaks.Allowed)
  return true
}

function scanQuote(scanner: Scanner, quote: string): boolean {
  if (scanner.peek() !== quote) return false
  scanQuoted(scanner, 1, quote, LineBreaks.EndString)
  return true
}
