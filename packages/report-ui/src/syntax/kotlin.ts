import { LineBreaks, scanBlockComment, scanLineComment, scanQuoted, SyntaxKind, words } from "./scanner.ts"
import type { Scanner, Vocabulary } from "./scanner.ts"

const VOCABULARY: Vocabulary = {
  keywords: words(
    "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while catch finally import companion constructor init",
  ),
  // Modifiers and soft keywords that are ordinary names elsewhere.
  contextualKeywords: words("abstract actual annotation by data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg get set field value"),
  constants: words("true false null"),
  types: words("Any Boolean Byte Char Double Float Int Long Nothing Short String Unit"),
  functionDefiners: words("fun"),
}

const ANNOTATION = /@[\w.]+/y
const RAW_STRING = '"""'

export function kotlinStep(scanner: Scanner): void {
  if (scanner.startsWith("//")) scanLineComment(scanner)
  else if (scanner.startsWith("/*")) scanBlockComment(scanner, "/*", "*/")
  else if (!scanToken(scanner)) scanner.pos++
}

function scanToken(scanner: Scanner): boolean {
  return (
    scanRawString(scanner) ||
    scanQuote(scanner, '"') ||
    scanQuote(scanner, "'") ||
    scanner.emitMatch(ANNOTATION, SyntaxKind.Meta) ||
    scanner.scanNumber() ||
    scanner.scanWord(VOCABULARY) !== undefined
  )
}

// A raw string has no escapes and can span lines.
function scanRawString(scanner: Scanner): boolean {
  if (!scanner.startsWith(RAW_STRING)) return false
  const closing = scanner.text.indexOf(RAW_STRING, scanner.pos + RAW_STRING.length)
  scanner.emit(SyntaxKind.String, closing === -1 ? scanner.text.length : closing + RAW_STRING.length)
  return true
}

function scanQuote(scanner: Scanner, quote: string): boolean {
  if (scanner.peek() !== quote) return false
  scanQuoted(scanner, 1, quote, LineBreaks.EndString)
  return true
}
