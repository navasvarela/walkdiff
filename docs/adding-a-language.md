# Adding a language

Everything the engine knows about a language lives in one module under
[`packages/engine/src/languages/`](../packages/engine/src/languages), listed in
[`registry.ts`](../packages/engine/src/languages/registry.ts). The checks read their rules from there,
so adding a language doesn't mean editing each check.

## What a language module holds

A module exports a `Language` ([`language.ts`](../packages/engine/src/languages/language.ts)):

| Field | What it's for | Leave empty when |
| --- | --- | --- |
| `name` | How the report names it, such as `C#` | Never |
| `spec` | How to parse it and find its functions, classes and references (see below) | Never |
| `extensions` | Lower-case, with the dot: `.rs` | Never |
| `family` | Languages with the same family can refer to each other's code, as C and C++ do through headers | It only refers to itself |
| `riskyApis` | Calls to flag on added lines, outside comments and strings: `eval`, `shell=True`, disabled TLS checks | Nothing stands out yet |
| `errorHandlers` | Syntax nodes where errors get swallowed or caught too broadly, and how to judge them | Its errors aren't caught in blocks |
| `routes` | How its web frameworks declare HTTP endpoints, for the attack surface check | It has no web frameworks |
| `librarySurface` | Which changed files other projects can import, for breaking-change checks | Public API rules aren't written yet |

An empty list is fine: the check skips the language, and the Risks tab says which checks don't cover
it yet. [`go.ts`](../packages/engine/src/languages/go.ts) is a short, complete example.

## The parser spec

`spec` is a `LanguageSpec` ([`syntax/languageSpec.ts`](../packages/engine/src/syntax/languageSpec.ts)),
in `packages/engine/src/syntax/`. It needs a [tree-sitter](https://tree-sitter.github.io/) grammar
built to WebAssembly, added as a dependency of `@walkdiff/engine`, and says:

- which syntax nodes are units (functions, methods, classes) and how they're named;
- which units other modules can reach;
- how identifiers are used, so references can be traced;
- how to read parameters, calls, branches and nesting, for function measures and signature changes.

The definition walker, change comparison and reference tracing are shared; a spec only answers those
questions for its grammar. Start from the closest existing language, and use the tree-sitter
playground or `parser.parse(source).rootNode.toString()` to see the node types.

## Elsewhere

- Add the language's id to `SourceLanguage` in
  [`review-model/src/schema.ts`](../packages/review-model/src/schema.ts), which the report records.
- The report colours code with its own small lexers in
  [`report-ui/src/syntax/`](../packages/report-ui/src/syntax). Without one, its code shows uncoloured.
- Tests: a parsing test like [`syntax/kotlinAndCsharp.test.ts`](../packages/engine/src/syntax/kotlinAndCsharp.test.ts),
  and cases for each rule list in the matching check's tests.
- The README and `site/manual.html` list the supported languages.
