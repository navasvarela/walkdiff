import { LineBreaks, scanBlockComment, scanLineComment, scanQuoted, SyntaxKind, words } from "./scanner.ts"
import type { Scanner, Vocabulary } from "./scanner.ts"

const VOCABULARY: Vocabulary = {
  keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  contextualKeywords: words(""),
  constants: words("true false nil iota"),
  types: words("any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr"),
  functionDefiners: words("func"),
}

// Go capitalises exported functions as well as types, so `fmt.Println(` is a call, not a type.
const CALLED_NAME = /[A-Za-z_]\w*(?=\()/y
const RAW_STRING_QUOTE = "`"

export function goStep(scanner: Scanner): void {
  if (scanner.startsWith("//")) scanLineComment(scanner)
  else if (scanner.startsWith("/*")) scanBlockComment(scanner, "/*", "*/")
  else if (!scanToken(scanner)) scanner.pos++
}

function scanToken(scanner: Scanner): boolean {
  return scanRawString(scanner) || scanQuote(scanner, '"') || scanQuote(scanner, "'") || scanner.scanNumber() || scanCall(scanner) || scanner.scanWord(VOCABULARY) !== undefined
}

// A raw string has no escapes, so a backslash before the closing backtick doesn't hide it.
function scanRawString(scanner: Scanner): boolean {
  if (scanner.peek() !== RAW_STRING_QUOTE) return false
  const closing = scanner.text.indexOf(RAW_STRING_QUOTE, scanner.pos + 1)
  scanner.emit(SyntaxKind.String, closing === -1 ? scanner.text.length : closing + 1)
  return true
}

function scanQuote(scanner: Scanner, quote: string): boolean {
  if (scanner.peek() !== quote) return false
  scanQuoted(scanner, 1, quote, LineBreaks.EndString)
  return true
}

// Keywords such as `func(` and conversions such as `int(x)` keep their own colour.
function scanCall(scanner: Scanner): boolean {
  const name = scanner.match(CALLED_NAME)
  if (name === undefined || VOCABULARY.keywords.has(name) || VOCABULARY.types.has(name)) return false
  scanner.emit(SyntaxKind.Function, scanner.pos + name.length)
  return true
}
