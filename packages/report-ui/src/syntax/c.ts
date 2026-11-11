import { LineBreaks, scanBlockComment, scanLineComment, scanQuoted, SyntaxKind, words } from "./scanner.ts"
import type { Scanner, Vocabulary } from "./scanner.ts"

const C_KEYWORDS =
  "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local"
const CPP_KEYWORDS =
  "alignas alignof asm catch class concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export friend mutable namespace new noexcept operator private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw try typeid typename using virtual"
const C_TYPES =
  "void char short int long float double signed unsigned bool _Bool _Complex size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t"
const CPP_TYPES = "char8_t char16_t char32_t"

export const C: Vocabulary = {
  keywords: words(C_KEYWORDS),
  contextualKeywords: words(""),
  constants: words("true false NULL"),
  types: words(C_TYPES),
  functionDefiners: words(""),
}

// C code may use C++ keywords such as `new` and `class` as names, so C++ gets its own set.
export const CPP: Vocabulary = {
  keywords: words(`${C_KEYWORDS} ${CPP_KEYWORDS}`),
  contextualKeywords: words(""),
  constants: words("true false NULL nullptr"),
  types: words(`${C_TYPES} ${CPP_TYPES}`),
  functionDefiners: words(""),
}

const DIRECTIVE = /#[ \t]*[A-Za-z_]\w*/y
// `#include <stdio.h>` names a file in angle brackets, which read as a string. The length cap
// keeps a line of unclosed `#include <` from rescanning the rest of the line for each one.
const INCLUDE_DIRECTIVE = /^#[ \t]*(?:include|include_next|import)$/
const ANGLE_PATH = /[ \t]*<[^>\n]{0,256}>/y
// `L"wide"`, `u8"text"` and `U'c'`: the prefix belongs to the literal.
const ENCODING_PREFIX = /(?:u8|[LuU])(?=["'])/y
// C++'s `R"tag(…)tag"` ends only at its own closing tag, whatever quotes or backslashes it holds.
const RAW_STRING_OPENER = /(?:u8|[LuU])?R"([^()\\\s]{0,16})\(/y
// C++14 separates digit groups with `'`, which would otherwise open a character literal.
const NUMBER = /0[xXbB][\da-fA-F']+[a-zA-Z\d]*|\d[\d']*(?:\.\d[\d']*)?(?:[eE][+-]?\d+)?[a-zA-Z\d_]*/y

export function createCStep(vocabulary: Vocabulary): (scanner: Scanner) => void {
  return (scanner) => {
    if (scanner.startsWith("//")) scanLineComment(scanner)
    else if (scanner.startsWith("/*")) scanBlockComment(scanner, "/*", "*/")
    else if (!scanToken(scanner, vocabulary)) scanner.pos++
  }
}

function scanToken(scanner: Scanner, vocabulary: Vocabulary): boolean {
  return (
    scanDirective(scanner) ||
    scanRawString(scanner) ||
    scanQuote(scanner) ||
    scanner.emitMatch(NUMBER, SyntaxKind.Constant) ||
    scanner.scanWord(vocabulary) !== undefined
  )
}

function scanDirective(scanner: Scanner): boolean {
  const directive = scanner.match(DIRECTIVE)
  if (directive === undefined) return false
  scanner.emit(SyntaxKind.Meta, scanner.pos + directive.length)
  if (INCLUDE_DIRECTIVE.test(directive)) scanner.emitMatch(ANGLE_PATH, SyntaxKind.String)
  return true
}

function scanRawString(scanner: Scanner): boolean {
  RAW_STRING_OPENER.lastIndex = scanner.pos
  const match = RAW_STRING_OPENER.exec(scanner.text)
  if (match === null) return false
  const closer = `)${match[1] ?? ""}"`
  const closing = scanner.text.indexOf(closer, scanner.pos + match[0].length)
  scanner.emit(SyntaxKind.String, closing === -1 ? scanner.text.length : closing + closer.length)
  return true
}

function scanQuote(scanner: Scanner): boolean {
  const prefixLength = scanner.match(ENCODING_PREFIX)?.length ?? 0
  const quote = scanner.peek(prefixLength)
  if (quote !== '"' && quote !== "'") return false
  scanQuoted(scanner, prefixLength + 1, quote, LineBreaks.EndString)
  return true
}
