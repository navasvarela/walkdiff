import { LineBreaks, scanBlockComment, scanLineComment, scanQuoted, SyntaxKind, words } from "./scanner.ts"
import type { Scanner, Vocabulary } from "./scanner.ts"

const VOCABULARY: Vocabulary = {
  keywords: words(
    "abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while",
  ),
  // Contextual keywords that are ordinary names elsewhere.
  contextualKeywords: words("async await var record init get set value when where yield required file global nameof"),
  constants: words("true false null"),
  types: words("bool byte char decimal double float int long nint nuint object sbyte short string uint ulong ushort void dynamic"),
  functionDefiners: words(""),
}

const RAW_STRING = '"""'
// `$"…{x}…"`, `@"C:\path"`, `$@"…"` and `@$"…"`: the prefix belongs to the string.
const STRING_PREFIX = /(?:\$@|@\$|\$|@)(?=")/y
const VERBATIM_MARK = "@"
// C# names methods in PascalCase, so `Start(` is a call, not a type.
const CALLED_NAME = /[A-Za-z_]\w*(?=\()/y

export function csharpStep(scanner: Scanner): void {
  if (scanner.startsWith("//")) scanLineComment(scanner)
  else if (scanner.startsWith("/*")) scanBlockComment(scanner, "/*", "*/")
  else if (!scanToken(scanner)) scanner.pos++
}

function scanToken(scanner: Scanner): boolean {
  return scanRawString(scanner) || scanString(scanner) || scanChar(scanner) || scanner.scanNumber() || scanCall(scanner) || scanner.scanWord(VOCABULARY) !== undefined
}

// Keywords such as `if (` and `typeof(` keep their own colour.
function scanCall(scanner: Scanner): boolean {
  const name = scanner.match(CALLED_NAME)
  if (name === undefined || VOCABULARY.keywords.has(name) || VOCABULARY.contextualKeywords.has(name) || VOCABULARY.types.has(name)) return false
  scanner.emit(SyntaxKind.Function, scanner.pos + name.length)
  return true
}

// C# 11's raw strings end only at their own closing quotes, and can span lines.
function scanRawString(scanner: Scanner): boolean {
  if (!scanner.startsWith(RAW_STRING)) return false
  const closing = scanner.text.indexOf(RAW_STRING, scanner.pos + RAW_STRING.length)
  scanner.emit(SyntaxKind.String, closing === -1 ? scanner.text.length : closing + RAW_STRING.length)
  return true
}

function scanString(scanner: Scanner): boolean {
  const prefix = scanner.match(STRING_PREFIX) ?? ""
  if (scanner.peek(prefix.length) !== '"') return false
  if (prefix.includes(VERBATIM_MARK)) scanVerbatim(scanner, prefix.length + 1)
  else scanQuoted(scanner, prefix.length + 1, '"', LineBreaks.EndString)
  return true
}

// A verbatim string has no backslash escapes: `""` is a quote, and it can span lines.
function scanVerbatim(scanner: Scanner, openLength: number): void {
  const { text } = scanner
  let index = scanner.pos + openLength
  while (index < text.length) {
    if (text.startsWith('""', index)) index += 2
    else if (text.charAt(index) === '"') return scanner.emit(SyntaxKind.String, index + 1)
    else index++
  }
  scanner.emit(SyntaxKind.String, text.length)
}

function scanChar(scanner: Scanner): boolean {
  if (scanner.peek() !== "'") return false
  scanQuoted(scanner, 1, "'", LineBreaks.EndString)
  return true
}
