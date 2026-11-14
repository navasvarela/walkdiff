import { describe, expect, it } from "vitest"
import { highlightLines, HighlightLanguage, languageForPath, MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINE_CHARS, segmentLine } from "./highlight.ts"
import { SyntaxKind } from "./scanner.ts"

/** Every coloured stretch as `kind:text`, joined across lines, so a test reads like the code it covers. */
function tokens(text: string, language: HighlightLanguage): string[] {
  const lines = text.split("\n")
  return highlightLines(text, language).flatMap((spans, index) => spans.map((span) => `${span.kind}:${(lines.at(index) ?? "").slice(span.start, span.end)}`))
}

describe("languageForPath", () => {
  it.each([
    ["src/main.rs", HighlightLanguage.Rust],
    ["a/b.ts", HighlightLanguage.TypeScript],
    ["a/b.mts", HighlightLanguage.TypeScript],
    ["a/b.tsx", HighlightLanguage.Tsx],
    ["a/b.js", HighlightLanguage.JavaScript],
    ["a/b.JSX", HighlightLanguage.JavaScript],
    ["a.b/c.py", HighlightLanguage.Python],
    ["cmd/main.go", HighlightLanguage.Go],
    ["src/main/java/A.java", HighlightLanguage.Java],
    ["app/src/main/kotlin/A.kt", HighlightLanguage.Kotlin],
    ["build.gradle.kts", HighlightLanguage.Kotlin],
    ["src/Server.cs", HighlightLanguage.CSharp],
    ["src/store.c", HighlightLanguage.C],
    ["include/store.h", HighlightLanguage.Cpp],
    ["src/server.cc", HighlightLanguage.Cpp],
    ["src/server.HPP", HighlightLanguage.Cpp],
    ["a/README.md", undefined],
    ["Makefile", undefined],
    ["a.py/Makefile", undefined],
  ])("%s", (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })
})

describe("TypeScript", () => {
  const language = HighlightLanguage.TypeScript

  it("colours keywords, types, calls and values", () => {
    expect(tokens(`export function total(items: Item[]): number {\n  return sum(items, 1.5) ?? null\n}`, language)).toEqual([
      "keyword:export",
      "keyword:function",
      "function:total",
      "type:Item",
      "type:number",
      "keyword:return",
      "function:sum",
      "constant:1.5",
      "constant:null",
    ])
  })

  it("treats contextual keywords as names unless a value follows", () => {
    expect(tokens(`type A = 1\nconst b = { type: 1 }\nb.type`, language)).toEqual(["keyword:type", "type:A", "constant:1", "keyword:const", "constant:1"])
  })

  it("does not read a member as a keyword", () => {
    expect(tokens(`p.catch(f).default`, language)).toEqual(["function:catch"])
  })

  it("carries a comment and a template across lines", () => {
    expect(tokens("/* a\nb */ x", language)).toEqual(["comment:/* a", "comment:b */"])
    expect(tokens("`a\nb` + 1", language)).toEqual(["string:`a", "string:b`", "constant:1"])
  })

  it("colours code inside template interpolation, including nested braces and templates", () => {
    expect(tokens("`a${ {b: f(`c${1}`)} }d` + 2", language)).toEqual([
      "string:`a",
      "function:f",
      "string:`c",
      "constant:1",
      "string:`",
      "string:d`",
      "constant:2",
    ])
  })

  it("tells a regex from division", () => {
    expect(tokens(`x = /a[/]b/g.test(y)`, language)).toEqual(["string:/a[/]b/g", "function:test"])
    expect(tokens(`a / b / c`, language)).toEqual([])
    expect(tokens(`f(x) / 2`, language)).toEqual(["function:f", "constant:2"])
  })

  it("ends a stray quote at the end of its line", () => {
    expect(tokens(`it's\nreturn`, language)).toEqual(["string:'s", "keyword:return"])
  })

  it("leaves angle brackets alone without JSX", () => {
    expect(tokens(`x = <T>y`, language)).toEqual(["type:T"])
  })
})

describe("JSX", () => {
  const language = HighlightLanguage.Tsx

  it("treats the text between tags as prose and colours expressions in it", () => {
    expect(tokens(`const a = <p className="b">Don't wait for {f(1)} in <Foo x={1} /></p>`, language)).toEqual([
      "keyword:const",
      "meta:p",
      'string:"b"',
      "function:f",
      "constant:1",
      "type:Foo",
      "constant:1",
      "meta:p",
    ])
  })

  it("returns to code after the element closes", () => {
    expect(tokens(`return <></> as X`, language)).toEqual(["keyword:return", "keyword:as", "type:X"])
    expect(tokens(`return <a/> / 2`, language)).toEqual(["keyword:return", "meta:a", "constant:2"])
  })

  it.each([
    ["const f = <T,>(x: T) => x", ["keyword:const", "type:T", "type:T"]],
    ["const f = <T extends U>(x: T) => x", ["keyword:const", "type:T", "keyword:extends", "type:U", "type:T"]],
    ["type F = <T>(x: T) => T", ["keyword:type", "type:F", "type:T", "type:T", "type:T"]],
    ["a < b", []],
    ["f(a) <b", ["function:f"]],
  ])("does not read %s as a tag", (code, expected) => {
    expect(tokens(code, language)).toEqual(expected)
  })
})

describe("JavaScript", () => {
  it("does not colour TypeScript words", () => {
    expect(tokens(`const string = interface`, HighlightLanguage.JavaScript)).toEqual(["keyword:const"])
  })
})

describe("Rust", () => {
  const language = HighlightLanguage.Rust

  it("colours definitions, types, macros and attributes", () => {
    expect(tokens(`#[derive(Debug)]\npub fn run(x: u32) -> Option<Foo> {\n  println!("{x}");\n}`, language)).toEqual([
      "meta:#[derive",
      "type:Debug",
      "keyword:pub",
      "keyword:fn",
      "function:run",
      "type:u32",
      "type:Option",
      "type:Foo",
      "function:println!",
      'string:"{x}"',
    ])
  })

  it("tells lifetimes from character literals", () => {
    expect(tokens(`fn f<'a, 'b>(x: &'a str) { 'a'; '\\n'; '\\u{1F600}'; b'x'; '😀' }`, language)).toEqual([
      "keyword:fn",
      "function:f",
      "meta:'a",
      "meta:'b",
      "meta:'a",
      "type:str",
      "string:'a'",
      "string:'\\n'",
      "string:'\\u{1F600}'",
      "string:b'x'",
      "string:'😀'",
    ])
  })

  it("nests block comments", () => {
    expect(tokens(`/* a /* b */ c */ fn`, language)).toEqual(["comment:/* a /* b */ c */", "keyword:fn"])
  })

  it("closes raw strings only at the matching hashes", () => {
    expect(tokens(`r#"a"b"# fn`, language)).toEqual([`string:r#"a"b"#`, "keyword:fn"])
    expect(tokens(`br"a" r"b"`, language)).toEqual([`string:br"a"`, `string:r"b"`])
    expect(tokens(`r#type`, language)).toEqual(["keyword:type"])
  })

  it("does not read a not-equals as a macro", () => {
    expect(tokens(`a!=b`, language)).toEqual([])
  })
})

describe("Python", () => {
  const language = HighlightLanguage.Python

  it("colours definitions, decorators and constants", () => {
    expect(tokens(`@app.route\ndef run(x: int = None):\n  return x @ y  # done`, language)).toEqual([
      "meta:@app.route",
      "keyword:def",
      "function:run",
      "type:int",
      "constant:None",
      "keyword:return",
      "comment:# done",
    ])
  })

  it("handles string prefixes, and only long strings cross lines", () => {
    expect(tokens(`f"a" rb'b'\n"""c\nd""" 'e\nx`, language)).toEqual([`string:f"a"`, "string:rb'b'", `string:"""c`, `string:d"""`, "string:'e"])
  })
})

describe("Go", () => {
  const language = HighlightLanguage.Go

  it("colours definitions, exported calls, types and values", () => {
    expect(tokens(`func (s *Server) Start(n int) error {\n  fmt.Println("hi", nil) // done\n  return int(n)\n}`, language)).toEqual([
      "keyword:func",
      "type:Server",
      "function:Start",
      "type:int",
      "type:error",
      "function:Println",
      'string:"hi"',
      "constant:nil",
      "comment:// done",
      "keyword:return",
      "type:int",
    ])
  })

  it("keeps raw strings literal across lines, and runes on one", () => {
    expect(tokens("x := `a\\\nb` + 'c'", language)).toEqual(["string:`a\\", "string:b`", "string:'c'"])
  })
})

describe("Java", () => {
  const language = HighlightLanguage.Java

  it("colours annotations, declarations and constructors", () => {
    expect(tokens(`@Override\npublic List<String> run(int a) { return new Foo(a, null); }`, language)).toEqual([
      "meta:@Override",
      "keyword:public",
      "type:List",
      "type:String",
      "function:run",
      "type:int",
      "keyword:return",
      "keyword:new",
      "type:Foo",
      "constant:null",
    ])
  })

  it("carries text blocks across lines, and treats newer keywords as names unless a value follows", () => {
    expect(tokens(`String s = """\n  a\n  """; var x = record;`, language)).toEqual(["type:String", 'string:"""', "string:  a", 'string:  """', "keyword:var"])
  })
})

describe("C", () => {
  const language = HighlightLanguage.C

  it("colours directives, include paths, types, calls and values", () => {
    expect(tokens(`#include <stdio.h>\nstatic int count(const char *s) {\n  return printf("%s", s) + NULL; /* done */\n}`, language)).toEqual([
      "meta:#include",
      "string: <stdio.h>",
      "keyword:static",
      "type:int",
      "function:count",
      "keyword:const",
      "type:char",
      "keyword:return",
      "function:printf",
      'string:"%s"',
      "constant:NULL",
      "comment:/* done */",
    ])
  })

  it("treats C++ keywords as names", () => {
    expect(tokens("int new = class;", language)).toEqual(["type:int"])
  })
})

describe("C++", () => {
  const language = HighlightLanguage.Cpp

  it("colours templates, namespaces and literals with prefixes", () => {
    expect(tokens(`template <typename T> class Box { auto x = nullptr; auto s = u8"hi"; };`, language)).toEqual([
      "keyword:template",
      "keyword:typename",
      "type:T",
      "keyword:class",
      "type:Box",
      "keyword:auto",
      "constant:nullptr",
      "keyword:auto",
      'string:u8"hi"',
    ])
  })

  it("reads raw strings to their own closing tag, and digit separators as part of a number", () => {
    expect(tokens(`auto s = R"sql(a ")" b)sql"; int n = 1'000;`, language)).toEqual([
      "keyword:auto",
      'string:R"sql(a ")" b)sql"',
      "type:int",
      "constant:1'000",
    ])
  })
})

describe("Kotlin", () => {
  const language = HighlightLanguage.Kotlin

  it("colours declarations, annotations, types and values", () => {
    expect(tokens(`@Service\nclass Server(val port: Int) {\n  override fun start(): String = "x" // done\n}`, language)).toEqual([
      "meta:@Service",
      "keyword:class",
      "type:Server",
      "keyword:val",
      "type:Int",
      "keyword:override",
      "keyword:fun",
      "function:start",
      "type:String",
      'string:"x"',
      "comment:// done",
    ])
  })

  it("carries raw strings across lines", () => {
    expect(tokens('val sql = """\nSELECT 1\n"""', language)).toEqual(["keyword:val", 'string:"""', "string:SELECT 1", 'string:"""'])
  })
})

describe("C#", () => {
  const language = HighlightLanguage.CSharp

  it("colours keywords, types, calls and interpolated strings", () => {
    expect(tokens(`public async Task<int> Start(string id) { await Run($"id {id}"); return null; }`, language)).toEqual([
      "keyword:public",
      "keyword:async",
      "type:Task",
      "type:int",
      "function:Start",
      "type:string",
      "keyword:await",
      "function:Run",
      'string:$"id {id}"',
      "keyword:return",
      "constant:null",
    ])
  })

  it("reads verbatim strings, where a doubled quote doesn't end them", () => {
    expect(tokens('var p = @"C:\\dir\\""x"""; var n = 1;', language)).toEqual(["keyword:var", 'string:@"C:\\dir\\""x"""', "keyword:var", "constant:1"])
  })
})

describe("highlightLines", () => {
  it("returns one entry per line, matching a split on line breaks", () => {
    const text = "a\n\nb\n"
    expect(highlightLines(text, HighlightLanguage.Rust)).toHaveLength(text.split("\n").length)
  })

  it("keeps a span's offsets relative to its own line", () => {
    expect(highlightLines("x\n  fn", HighlightLanguage.Rust).at(1)).toEqual([{ start: 2, end: 4, kind: SyntaxKind.Keyword }])
  })

  it("stays plain for an unknown language or a huge text", () => {
    expect(highlightLines("fn", undefined)).toEqual([])
    expect(highlightLines(`fn ${"x".repeat(MAX_HIGHLIGHT_CHARS)}`, HighlightLanguage.Rust)).toEqual([])
  })

  it("leaves only a very long line plain, and keeps lexing past it", () => {
    const lines = highlightLines(`fn\n/* ${"x".repeat(MAX_HIGHLIGHT_LINE_CHARS)}\nfn */ fn`, HighlightLanguage.Rust)
    expect(lines.at(0)).toEqual([{ start: 0, end: 2, kind: SyntaxKind.Keyword }])
    expect(lines.at(1)).toEqual([])
    expect(lines.at(2)).toEqual([
      { start: 0, end: 5, kind: SyntaxKind.Comment },
      { start: 6, end: 8, kind: SyntaxKind.Keyword },
    ])
  })

  // Each of these made Prism or highlight.js take seconds at 100 KB, or targets a lookahead of ours.
  const HOSTILE_INPUTS = ["<a b=", "<a>", '`${', 'r#"', "/[", "/*", "'", '"""', "foo(", "#[", "{", "<", "\\", "function ", "@", "#include <", 'R"(', "u8'", "1'", '@"', '$@"', '"""']
  const HOSTILE_LANGUAGES = Object.values(HighlightLanguage)
  // Far above the few milliseconds these take, and far below the seconds a backtracking pattern takes.
  const SLOW_MS = 1_000

  it.each(HOSTILE_INPUTS)("stays fast on a line of repeated %s", (fragment) => {
    const text = fragment.repeat(Math.floor(MAX_HIGHLIGHT_CHARS / fragment.length))
    const started = performance.now()
    for (const language of HOSTILE_LANGUAGES) highlightLines(text, language)
    expect(performance.now() - started).toBeLessThan(SLOW_MS)
  })
})

describe("segmentLine", () => {
  const keyword = { start: 0, end: 2, kind: SyntaxKind.Keyword }

  it("gives a line with no spans or marks one plain segment", () => {
    expect(segmentLine("abc", [], [])).toEqual([{ text: "abc", kind: undefined, marked: false }])
  })

  it("gives an empty line no segments", () => {
    expect(segmentLine("", [], [])).toEqual([])
  })

  it("cuts where a mark ends in the middle of a token", () => {
    expect(segmentLine("fn x", [keyword], [{ start: 1, end: 3 }])).toEqual([
      { text: "f", kind: SyntaxKind.Keyword, marked: false },
      { text: "n", kind: SyntaxKind.Keyword, marked: true },
      { text: " ", kind: undefined, marked: true },
      { text: "x", kind: undefined, marked: false },
    ])
  })

  it("marks a whole token and keeps its colour", () => {
    expect(segmentLine("fn", [keyword], [{ start: 0, end: 2 }])).toEqual([{ text: "fn", kind: SyntaxKind.Keyword, marked: true }])
  })

  it("always reproduces the text exactly", () => {
    const text = "fn héllo 😀"
    const joined = segmentLine(text, [keyword, { start: 3, end: 8, kind: SyntaxKind.Function }], [{ start: 1, end: 4 }, { start: 6, end: 11 }])
    expect(joined.map((segment) => segment.text).join("")).toBe(text)
  })

  it("ignores ranges past the end of the text", () => {
    expect(segmentLine("ab", [{ start: 1, end: 9, kind: SyntaxKind.Keyword }], [{ start: 5, end: 9 }]).map((segment) => segment.text)).toEqual(["a", "b"])
  })
})
