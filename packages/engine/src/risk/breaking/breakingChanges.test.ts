import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { commitShaSchema, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { CommitSha, RiskAssessment } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { analyzeChangedFiles } from "../../analyzeChangedFiles.ts"
import { runGit } from "../../git.ts"

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

type Files = Readonly<Record<string, string | null>>

async function assess(before: Files, after: Files): Promise<RiskAssessment> {
  const repoDir = await mkdtemp(join(tmpdir(), "walkdiff-breaking-"))
  const git = (...args: string[]): Promise<string> => runGit(args, { cwd: repoDir, env: COMMITTER_ENV })
  const commit = async (files: Files): Promise<CommitSha> => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        await rm(join(repoDir, path))
        continue
      }
      await mkdir(dirname(join(repoDir, path)), { recursive: true })
      await writeFile(join(repoDir, path), content)
    }
    await git("add", "--all")
    await git("commit", "--quiet", "--allow-empty", "--message", "change")
    return commitShaSchema.parse((await git("rev-parse", "HEAD")).trim())
  }
  try {
    await git("init", "--quiet")
    const base = await commit(before)
    const head = await commit(after)
    return (await analyzeChangedFiles(repoDir, base, head, { network: false, runScanner: async () => undefined })).risk
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
}

async function flagged(before: Files, after: Files): Promise<string[]> {
  const risk = await assess(before, after)
  return risk.findings.filter((finding) => finding.category === RiskCategory.BreakingChange).map((finding) => finding.title.replaceAll("`", ""))
}

const RUST_LIBRARY: Files = { "Cargo.toml": '[package]\nname = "lib"\n', "src/lib.rs": "pub mod api;\nmod internal;\npub use internal::exported;\n" }
const RUST_BINARY: Files = { "Cargo.toml": '[package]\nname = "app"\n', "src/main.rs": "mod api;\nfn main() {}\n" }
const TS_LIBRARY: Files = { "package.json": '{"name":"lib","main":"dist/index.js"}', "src/index.ts": 'export * from "./api"\nexport { picked } from "./other"\n' }
const TS_APP: Files = { "package.json": '{"name":"app","private":true}' }
const PY_LIBRARY: Files = { "pyproject.toml": '[build-system]\nrequires = ["hatchling"]\n' }
const GO_MODULE: Files = { "go.mod": "module example.com/lib\n\ngo 1.22\n" }

interface ApiCase {
  readonly name: string
  readonly project: Files
  readonly path: string
  readonly before: string
  readonly after: string | null
  readonly other?: Files
  readonly expected: readonly string[]
}

const FLAGGED_API: readonly ApiCase[] = [
  { name: "rust: removed pub fn", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(a: u8) -> u8 { a }\npub fn keep() {}\n", after: "pub fn keep() {}\n", expected: ["Public function parse was removed"] },
  { name: "rust: renamed pub fn", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(a: u8) -> u8 { a + 1 }\n", after: "pub fn decode(a: u8) -> u8 { a + 1 }\n", expected: ["Public function parse was renamed to decode"] },
  { name: "rust: new parameter", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(a: u8) {}\n", after: "pub fn parse(a: u8, limit: u8) {}\n", expected: ["parse has a new required parameter limit"] },
  { name: "rust: removed parameter", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(a: u8, limit: u8) {}\n", after: "pub fn parse(a: u8) {}\n", expected: ["parse no longer takes limit"] },
  { name: "rust: changed parameter type", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(a: u8) {}\n", after: "pub fn parse(a: u16) {}\n", expected: ["parse changes the type of a from u8 to u16"] },
  { name: "rust: changed return type", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse() -> u8 { 1 }\n", after: "pub fn parse() -> Option<u8> { None }\n", expected: ["parse changes its return type from u8 to Option<u8>"] },
  { name: "rust: dropped return value", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse() -> u8 { 1 }\n", after: "pub fn parse() {}\n", expected: ["parse no longer returns u8"] },
  { name: "rust: narrowed visibility", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse() {}\n", after: "pub(crate) fn parse() {}\n", expected: ["Public function parse is no longer public"] },
  { name: "rust: method on public struct", project: RUST_LIBRARY, path: "src/api.rs", before: "pub struct Foo;\nimpl Foo {\n    pub fn run(&self, a: u8) {}\n}\n", after: "pub struct Foo;\nimpl Foo {\n    pub fn run(&self, a: u8, b: u8) {}\n}\n", expected: ["Foo::run has a new required parameter b"] },
  { name: "rust: method of a public trait", project: RUST_LIBRARY, path: "src/api.rs", before: "pub trait Foo {\n    fn run(&self, a: u8);\n}\n", after: "pub trait Foo {\n    fn run(&self);\n}\n", expected: ["Foo::run no longer takes a"] },
  { name: "rust: item re-exported from a private module", project: RUST_LIBRARY, path: "src/internal.rs", before: "pub fn exported(a: u8) {}\n", after: "pub fn exported() {}\n", expected: ["exported no longer takes a"] },
  { name: "rust: removed public type", project: RUST_LIBRARY, path: "src/api.rs", before: "pub struct Config {\n    pub a: u8,\n}\n", after: "", expected: ["Public struct Config was removed"] },
  { name: "ts: removed export", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string): void {}\nexport function keep(): void {}\n", after: "export function keep(): void {}\n", expected: ["Public function parse was removed"] },
  { name: "ts: removed exported type", project: TS_LIBRARY, path: "src/api.ts", before: "export interface Options {\n  a: string\n}\nexport function keep(): void {}\n", after: "export function keep(): void {}\n", expected: ["Public interface Options was removed"] },
  { name: "ts: export clause counts as public", project: TS_LIBRARY, path: "src/api.ts", before: "function parse(a: string): void {}\nexport { parse }\n", after: "function parse(a: string, b: string): void {}\nexport { parse }\n", expected: ["parse has a new required parameter b"] },
  { name: "ts: named re-export from the entry point", project: TS_LIBRARY, path: "src/other.ts", before: "export function picked(a: string): void {}\n", after: "export function picked(): void {}\n", expected: ["picked no longer takes a"] },
  { name: "ts: optional became required", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a?: string): void {}\n", after: "export function parse(a: string): void {}\n", expected: ["parse now requires a"] },
  { name: "ts: default removed", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a = 1): void {}\n", after: "export function parse(a: number): void {}\n", expected: ["parse now requires a"] },
  { name: "ts: narrower parameter type", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string | number): void {}\n", after: "export function parse(a: string): void {}\n", expected: ["parse changes the type of a from string | number to string"] },
  { name: "ts: wider return type", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(): string { return '' }\n", after: "export function parse(): string | null { return null }\n", expected: ["parse changes its return type from string to string | null"] },
  { name: "ts: options object gains a required member", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: { b: string }): void {}\n", after: "export function parse(a: { b: string; c: number }): void {}\n", expected: ["parse changes the type of a from { b: string } to { b: string; c: number }"] },
  { name: "ts: arrow function", project: TS_LIBRARY, path: "src/api.ts", before: "export const parse = (a: string): void => {}\n", after: "export const parse = (a: string, b: number): void => {}\n", expected: ["parse has a new required parameter b"] },
  { name: "ts: class method", project: TS_LIBRARY, path: "src/api.ts", before: "export class Foo {\n  run(a: string): void {}\n}\n", after: "export class Foo {\n  run(): void {}\n}\n", expected: ["Foo.run no longer takes a"] },
  { name: "ts: export removed", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(): void {}\n", after: "function parse(): void {}\nparse()\n", expected: ["Public function parse is no longer public"] },
  { name: "go: removed exported function", project: GO_MODULE, path: "api/api.go", before: "package api\n\nfunc Parse(a int) int { return a }\n\nfunc Keep() {}\n", after: "package api\n\nfunc Keep() {}\n", expected: ["Public function Parse was removed"] },
  { name: "go: new parameter in a grouped declaration", project: GO_MODULE, path: "api/api.go", before: "package api\n\nfunc Parse(a int) int { return a }\n", after: "package api\n\nfunc Parse(a, b int) int { return a }\n", expected: ["Parse has a new required parameter b"] },
  { name: "go: method of an exported type", project: GO_MODULE, path: "api/api.go", before: "package api\n\ntype Server struct{}\n\nfunc (s *Server) Start(port int) {}\n", after: "package api\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n", expected: ["Server.Start no longer takes port"] },
  { name: "python: removed function", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a):\n    return a\n\ndef keep():\n    return 1\n", after: "def keep():\n    return 1\n", expected: ["Public function parse was removed"] },
  { name: "python: removed class", project: PY_LIBRARY, path: "pkg/api.py", before: "class Foo:\n    pass\n\ndef keep():\n    return 1\n", after: "def keep():\n    return 1\n", expected: ["Public class Foo was removed"] },
  { name: "python: new required parameter", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a):\n    return a\n", after: "def parse(a, b):\n    return a\n", expected: ["parse has a new required parameter b"] },
  { name: "python: removed parameter", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a, b=1):\n    return a\n", after: "def parse(a):\n    return a\n", expected: ["parse no longer takes b"] },
  { name: "python: renamed parameter", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a, size):\n    return a\n", after: "def parse(a, length):\n    return a\n", expected: ["parse renames its parameter size to length"] },
  { name: "python: default removed", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a=1):\n    return a\n", after: "def parse(a):\n    return a\n", expected: ["parse now requires a"] },
  { name: "python: became keyword-only", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a, b):\n    return a\n", after: "def parse(a, *, b):\n    return a\n", expected: ["parse now takes b only by keyword"] },
  { name: "python: reordered", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a, b):\n    return a\n", after: "def parse(b, a):\n    return a\n", expected: ["parse reorders its parameters b, a"] },
  { name: "python: changed return annotation", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse() -> int:\n    return 1\n", after: "def parse() -> str:\n    return ''\n", expected: ["parse changes its return type from int to str"] },
  { name: "python: constructor", project: PY_LIBRARY, path: "pkg/api.py", before: "class Foo:\n    def __init__(self, a):\n        self.a = a\n", after: "class Foo:\n    def __init__(self, a, b):\n        self.a = a\n", expected: ["Foo.__init__ has a new required parameter b"] },
  { name: "python: private module its package re-exports (encode/httpx#3319)", project: { ...PY_LIBRARY, "pkg/__init__.py": "from ._api import *\n" }, path: "pkg/_api.py", before: "def parse(a):\n    return a\n", after: "def parse():\n    return 1\n", expected: ["parse no longer takes a"] },
  { name: "python: named re-export from a private module", project: { ...PY_LIBRARY, "pkg/__init__.py": "from ._api import (\n    parse,\n)\n" }, path: "pkg/_api.py", before: "def parse(a):\n    return a\n", after: "def parse():\n    return 1\n", expected: ["parse no longer takes a"] },
  { name: "python: parameter absorbed by kwargs", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a, b):\n    return a\n", after: "def parse(a, **kwargs):\n    return a\n", expected: ["parse no longer names b, which now goes to **kwargs"] },
]

const NOT_FLAGGED_API: readonly ApiCase[] = [
  { name: "rust: binary crate, every caller updated", project: RUST_BINARY, path: "src/api.rs", before: "pub fn parse(a: u8) {}\n", after: "pub fn parse(a: u8, b: u8) {}\n", expected: [] },
  { name: "rust: binary crate, removed function", project: RUST_BINARY, path: "src/api.rs", before: "pub fn parse(a: u8) {}\npub fn keep() {}\n", after: "pub fn keep() {}\n", expected: [] },
  { name: "rust: private function", project: RUST_LIBRARY, path: "src/api.rs", before: "fn parse(a: u8) {}\n", after: "fn parse(a: u8, b: u8) {}\n", expected: [] },
  { name: "rust: pub(crate)", project: RUST_LIBRARY, path: "src/api.rs", before: "pub(crate) fn parse(a: u8) {}\n", after: "pub(crate) fn parse() {}\n", expected: [] },
  { name: "rust: public item in a private module", project: RUST_LIBRARY, path: "src/internal.rs", before: "pub fn hidden(a: u8) {}\n", after: "pub fn hidden() {}\n", expected: [] },
  { name: "rust: public item in an inline private module", project: RUST_LIBRARY, path: "src/api.rs", before: "mod inner {\n    pub fn parse(a: u8) {}\n}\n", after: "mod inner {\n    pub fn parse() {}\n}\n", expected: [] },
  { name: "rust: pub method on a private struct", project: RUST_LIBRARY, path: "src/api.rs", before: "struct Foo;\nimpl Foo {\n    pub fn run(&self, a: u8) {}\n}\n", after: "struct Foo;\nimpl Foo {\n    pub fn run(&self) {}\n}\n", expected: [] },
  { name: "rust: trait impl methods follow the trait", project: RUST_LIBRARY, path: "src/api.rs", before: "pub struct Foo;\nimpl Display for Foo {\n    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }\n}\n", after: "pub struct Foo;\nimpl Display for Foo {\n    fn fmt(&self, out: &mut Formatter) -> Result { Ok(()) }\n}\n", expected: [] },
  { name: "rust: never published", project: { "Cargo.toml": '[package]\nname = "lib"\npublish = false\n', "src/lib.rs": "pub mod api;\n" }, path: "src/api.rs", before: "pub fn parse(a: u8) {}\n", after: "pub fn parse() {}\n", expected: [] },
  { name: "rust: renamed parameter breaks no one", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(size: u8) {}\n", after: "pub fn parse(length: u8) {}\n", expected: [] },
  { name: "rust: lifetimes and paths are spelling", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse<'a>(a: &'a str) -> std::fmt::Result { todo!() }\n", after: "pub fn parse(a: &str) -> fmt::Result { todo!() }\n", expected: [] },
  { name: "rust: accepts more than before", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn parse(a: &String, b: &Vec<u8>, c: String) {}\n", after: "pub fn parse(a: &str, b: &[u8], c: impl Into<String>) {}\n", expected: [] },
  { name: "rust: test module", project: RUST_LIBRARY, path: "src/api.rs", before: "pub mod tests {\n    pub fn helper(a: u8) {}\n}\n", after: "pub mod tests {\n    pub fn helper() {}\n}\n", expected: [] },
  { name: "rust: alias kept", project: RUST_LIBRARY, path: "src/api.rs", before: "pub fn old_name() { step(); step(); }\npub fn keep() {}\n", after: "pub use self::keep as old_name;\npub fn keep() {}\n", expected: [] },
  { name: "ts: not reachable from the entry point", project: TS_LIBRARY, path: "src/util.ts", before: "export function parse(a: string): void {}\n", after: "export function parse(): void {}\n", expected: [] },
  { name: "ts: only some names are re-exported", project: TS_LIBRARY, path: "src/other.ts", before: "export function unpicked(a: string): void {}\n", after: "export function unpicked(): void {}\n", expected: [] },
  { name: "ts: private package", project: { ...TS_APP, "src/index.ts": 'export * from "./api"\n' }, path: "src/api.ts", before: "export function parse(a: string): void {}\n", after: "export function parse(): void {}\n", expected: [] },
  { name: "ts: no package.json", project: {}, path: "src/index.ts", before: "export function parse(a: string): void {}\n", after: "export function parse(): void {}\n", expected: [] },
  { name: "ts: not exported", project: TS_LIBRARY, path: "src/api.ts", before: "function parse(a: string): void {}\n", after: "function parse(): void {}\n", expected: [] },
  { name: "ts: new optional parameter", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string): void {}\n", after: "export function parse(a: string, b?: number, c = 1): void {}\n", expected: [] },
  { name: "ts: parameter became optional", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string): void {}\n", after: "export function parse(a?: string): void {}\n", expected: [] },
  { name: "ts: renamed parameter breaks no one", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(size: number): void {}\n", after: "export function parse(length: number): void {}\n", expected: [] },
  { name: "ts: wider parameter type", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string, b: string[]): void {}\n", after: "export function parse(a: string | null, b: readonly string[]): void {}\n", expected: [] },
  { name: "ts: narrower return type", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(): string | null { return null }\n", after: "export function parse(): string { return '' }\n", expected: [] },
  { name: "ts: return type spelled differently", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(): Array<string> { return [] }\n", after: "export function parse(): string[] { return [] }\n", expected: [] },
  { name: "ts: options object gains an optional member (formbricks/formbricks#9719)", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: { b: string }): void {}\n", after: "export function parse(a: { b: string; c?: number }): void {}\n", expected: [] },
  { name: "ts: documented member added to an options object (formbricks/formbricks#9719)", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: {\n  /** The name. */\n  b: string;\n}): void {}\n", after: "export function parse(a: {\n  /** The name. */\n  b: string;\n  /** The limit. */\n  c?: number;\n}): void {}\n", expected: [] },
  { name: "ts: void now returns something", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(): void {}\n", after: "export function parse(): string { return '' }\n", expected: [] },
  { name: "ts: inferred return type", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(): string { return '' }\n", after: "export function parse() { return 1 }\n", expected: [] },
  { name: "ts: private and protected members", project: TS_LIBRARY, path: "src/api.ts", before: "export class Foo {\n  private run(a: string): void {}\n  protected go(a: string): void {}\n  #hide(a: string): void {}\n}\n", after: "export class Foo {\n  private run(): void {}\n  protected go(): void {}\n  #hide(): void {}\n}\n", expected: [] },
  { name: "ts: overloads", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string): void\nexport function parse(a: number): void\nexport function parse(a: unknown): void {}\n", after: "export function parse(a: boolean): void\nexport function parse(a: string): void\nexport function parse(a: number): void\nexport function parse(a: unknown): void {}\n", expected: [] },
  { name: "ts: decorated method", project: TS_LIBRARY, path: "src/api.ts", before: "export class Foo {\n  @Get()\n  run(a: string): void {}\n}\n", after: "export class Foo {\n  @Get()\n  run(): void {}\n}\n", expected: [] },
  { name: "ts: alias kept", project: TS_LIBRARY, path: "src/api.ts", before: "export function old(): void { step(); step() }\nexport function keep(): void {}\n", after: "export function keep(): void {}\nexport { keep as old }\n", expected: [] },
  { name: "ts: moved to another file with edits", project: TS_LIBRARY, path: "src/api.ts", before: "export function parse(a: string): void {}\nexport function keep(): void {}\n", after: "export function keep(): void {}\n", other: { "src/moved.ts": "export function parse(a: string): number { return 1 }\n" }, expected: [] },
  { name: "python: private function", project: PY_LIBRARY, path: "pkg/api.py", before: "def _parse(a):\n    return a\n", after: "def _parse(a, b):\n    return a\n", expected: [] },
  { name: "python: private method", project: PY_LIBRARY, path: "pkg/api.py", before: "class Foo:\n    def _run(self, a):\n        return a\n", after: "class Foo:\n    def _run(self):\n        return 1\n", expected: [] },
  { name: "python: method of a private class", project: PY_LIBRARY, path: "pkg/api.py", before: "class _Foo:\n    def run(self, a):\n        return a\n", after: "class _Foo:\n    def run(self):\n        return 1\n", expected: [] },
  { name: "python: private module", project: PY_LIBRARY, path: "pkg/_impl.py", before: "def parse(a):\n    return a\n", after: "def parse(a, b):\n    return a\n", expected: [] },
  { name: "python: other names re-exported from a private module", project: { ...PY_LIBRARY, "pkg/__init__.py": "from ._api import keep\n" }, path: "pkg/_api.py", before: "def parse(a):\n    return a\n", after: "def parse():\n    return 1\n", expected: [] },
  { name: "python: left out of __all__", project: PY_LIBRARY, path: "pkg/api.py", before: '__all__ = ["keep"]\n\ndef parse(a):\n    return a\n', after: '__all__ = ["keep"]\n\ndef parse(a, b):\n    return a\n', expected: [] },
  { name: "python: application without a build backend", project: { "pyproject.toml": "[tool.ruff]\nline-length = 100\n" }, path: "pkg/api.py", before: "def parse(a):\n    return a\n", after: "def parse(a, b):\n    return a\n", expected: [] },
  { name: "python: no project file", project: {}, path: "pkg/api.py", before: "def parse(a):\n    return a\n", after: "def parse(a, b):\n    return a\n", expected: [] },
  { name: "python: scripts folder", project: PY_LIBRARY, path: "scripts/release.py", before: "def parse(a):\n    return a\n", after: "def parse(a, b):\n    return a\n", expected: [] },
  { name: "python: new optional parameter", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a):\n    return a\n", after: "def parse(a, b=1, *args, c=2, **kwargs):\n    return a\n", expected: [] },
  { name: "python: default value changed", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a=1):\n    return a\n", after: "def parse(a=2):\n    return a\n", expected: [] },
  { name: "python: annotations aren't enforced", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a: int):\n    return a\n", after: "def parse(a: str):\n    return a\n", expected: [] },
  { name: "python: modernised annotations", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse() -> t.Optional[List[int]]:\n    return None\n", after: "def parse() -> list[int] | None:\n    return None\n", expected: [] },
  { name: "python: comparison hook", project: PY_LIBRARY, path: "pkg/api.py", before: "class Foo:\n    def __eq__(self, other):\n        return True\n", after: "class Foo:\n    def __eq__(self, that, extra):\n        return False\n", expected: [] },
  { name: "python: framework handler", project: PY_LIBRARY, path: "pkg/api.py", before: '@app.route("/")\ndef index(a):\n    return a\n', after: '@app.route("/")\ndef index(a, b):\n    return a\n', expected: [] },
  { name: "python: overloads", project: PY_LIBRARY, path: "pkg/api.py", before: "@overload\ndef parse(a: int) -> int: ...\n@overload\ndef parse(a: str) -> str: ...\ndef parse(a):\n    return a\n", after: "@overload\ndef parse(a: bytes) -> bytes: ...\n@overload\ndef parse(a: int) -> int: ...\n@overload\ndef parse(a: str) -> str: ...\ndef parse(a):\n    return a\n", expected: [] },
  { name: "python: alias kept", project: PY_LIBRARY, path: "pkg/api.py", before: "def old_name(a):\n    return a\n\ndef keep(a):\n    return a\n", after: "def keep(a):\n    return a\n\nold_name = keep\n", expected: [] },
  { name: "python: method moved to a base class", project: PY_LIBRARY, path: "pkg/api.py", before: "class Base:\n    pass\n\nclass Foo(Base):\n    def run(self):\n        return 1\n", after: "class Base:\n    def run(self):\n        return 2\n\nclass Foo(Base):\n    pass\n", expected: [] },
  // Each of these was a false alarm on a real pull request.
  { name: "python: deprecating __getattr__ still serves the name (pallets/werkzeug#3321)", project: PY_LIBRARY, path: "pkg/api.py", before: "def parse(a):\n    return a\n\ndef keep():\n    return 1\n", after: 'def keep():\n    return 1\n\ndef __getattr__(name):\n    if name == "parse":\n        return keep\n    raise AttributeError(name)\n', expected: [] },
  { name: "python: return type restated as Self (pallets/werkzeug#3339)", project: PY_LIBRARY, path: "pkg/api.py", before: "class Response:\n    def copy(self) -> Response:\n        return self\n", after: "class Response:\n    def copy(self) -> t.Self:\n        return self\n", expected: [] },
  { name: "python: test file", project: PY_LIBRARY, path: "tests/test_api.py", before: "def helper(a):\n    return a\n", after: "def helper(a, b):\n    return a\n", expected: [] },
  { name: "go: unexported function", project: GO_MODULE, path: "api/api.go", before: "package api\n\nfunc parse(a int) {}\n", after: "package api\n\nfunc parse() {}\n", expected: [] },
  { name: "go: method of an unexported type", project: GO_MODULE, path: "api/api.go", before: "package api\n\ntype server struct{}\n\nfunc (s *server) Start(port int) {}\n", after: "package api\n\ntype server struct{}\n\nfunc (s *server) Start() {}\n", expected: [] },
  { name: "go: internal package", project: GO_MODULE, path: "internal/api/api.go", before: "package api\n\nfunc Parse(a int) {}\n", after: "package api\n\nfunc Parse() {}\n", expected: [] },
  { name: "go: package main", project: GO_MODULE, path: "cmd/tool/main.go", before: "package main\n\nfunc Parse(a int) {}\n", after: "package main\n\nfunc Parse() {}\n", expected: [] },
  { name: "go: test file", project: GO_MODULE, path: "api/api_test.go", before: "package api\n\nfunc Helper(a int) {}\n", after: "package api\n\nfunc Helper() {}\n", expected: [] },
  { name: "go: no go.mod", project: {}, path: "api/api.go", before: "package api\n\nfunc Parse(a int) {}\n", after: "package api\n\nfunc Parse() {}\n", expected: [] },
  { name: "go: renamed parameter breaks no one", project: GO_MODULE, path: "api/api.go", before: "package api\n\nfunc Parse(size int) {}\n", after: "package api\n\nfunc Parse(length int) {}\n", expected: [] },
]

describe("public API changes", () => {
  it.each([...FLAGGED_API, ...NOT_FLAGGED_API])("$name", async ({ project, path, before, after, other, expected }) => {
    const titles = await flagged({ ...project, [path]: before }, { [path]: after, ...other })
    expect(titles).toEqual(expected)
  })

  it("collapses a module's worth of removals into one finding", async () => {
    const titles = await flagged({ ...PY_LIBRARY, "pkg/api.py": "def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n" }, { "pkg/api.py": null })
    expect(titles).toEqual(["3 public items were removed from pkg/api.py"])
  })

  it("names the untouched callers of an internal API, whose break is certain", async () => {
    const risk = await assess(
      { ...RUST_BINARY, "src/api.rs": "pub fn parse(a: u8) {}\n", "src/run.rs": "use crate::api;\n\npub fn run() {\n    api::parse(1);\n}\n" },
      { "src/api.rs": "pub fn parse(a: u8, b: u8) {}\n" },
    )
    const finding = risk.findings.find((candidate) => candidate.category === RiskCategory.BreakingChange)
    expect(finding).toMatchObject({ ruleId: "breaking.api-signature", severity: RiskSeverity.High, title: "`parse` has a new required parameter `b`", location: { path: "src/api.rs", line: 1 }, unit: "parse" })
    expect(finding?.detail).toContain("Callers will likely break")
    expect(finding?.detail).toContain("src/run.rs:4 (run)")
  })

  it("doesn't take a variable sharing the function's name for a caller (encode/httpx#3319)", async () => {
    const risk = await assess(
      { ...PY_LIBRARY, "pkg/api.py": "def request(url, proxies):\n    return url\n", "pkg/auth.py": "from pkg.models import request\n\ndef sign():\n    return request\n" },
      { "pkg/api.py": "def request(url):\n    return url\n" },
    )
    const finding = risk.findings.find((candidate) => candidate.category === RiskCategory.BreakingChange)
    expect(finding).toMatchObject({ severity: RiskSeverity.Medium, title: "`request` no longer takes `proxies`" })
    expect(finding?.detail).not.toContain("pkg/auth.py")
  })

  it("rates dropping an optional parameter below dropping a required one", async () => {
    const callers = { "pkg/run.py": "from pkg.api import parse\n\ndef run():\n    return parse(1)\n" }
    const risk = await assess({ ...PY_LIBRARY, ...callers, "pkg/api.py": "def parse(a, b=1):\n    return a\n" }, { "pkg/api.py": "def parse(a):\n    return a\n" })
    expect(risk.findings.find((candidate) => candidate.category === RiskCategory.BreakingChange)).toMatchObject({ severity: RiskSeverity.Medium, title: "`parse` no longer takes `b`" })
  })

  it("counts a declaration and a value under one name once", async () => {
    const titles = await flagged(
      { ...TS_LIBRARY, "src/api.ts": "export interface Foo { a: string }\nexport const Foo = 1\nexport function bar(): void {}\nexport function baz(): void {}\nexport function keep(): void {}\n" },
      { "src/api.ts": "export function keep(): void {}\n" },
    )
    expect(titles).toEqual(["3 public items were removed from src/api.ts"])
  })

  it("only says may break when the change doesn't break every caller", async () => {
    const risk = await assess(
      { ...RUST_BINARY, "src/api.rs": "pub fn parse(a: u8) {}\n", "src/run.rs": "use crate::api;\n\npub fn run() {\n    api::parse(1);\n}\n" },
      { "src/api.rs": "pub fn parse(a: u16) {}\n" },
    )
    const finding = risk.findings.find((candidate) => candidate.category === RiskCategory.BreakingChange)
    expect(finding).toMatchObject({ severity: RiskSeverity.Medium })
    expect(finding?.detail).toContain("Callers may break")
  })

  it("leaves a removal with callers left behind to the broken reference finding", async () => {
    const risk = await assess(
      { ...PY_LIBRARY, "pkg/api.py": "def parse(a):\n    return a\n\ndef keep():\n    return 1\n", "pkg/run.py": "from pkg.api import parse\n\ndef run():\n    return parse(1)\n" },
      { "pkg/api.py": "def keep():\n    return 1\n" },
    )
    expect(risk.findings.map((finding) => finding.ruleId)).toContain("reference.stale")
    expect(risk.findings.filter((finding) => finding.category === RiskCategory.BreakingChange)).toEqual([])
  })

  it("points a removed unit's finding at the unit, which has no line at head", async () => {
    const risk = await assess({ ...PY_LIBRARY, "pkg/api.py": "def parse(a):\n    return a\n\ndef keep():\n    return 1\n" }, { "pkg/api.py": "def keep():\n    return 1\n" })
    expect(risk.findings.find((finding) => finding.category === RiskCategory.BreakingChange)).toMatchObject({ location: { path: "pkg/api.py", line: null }, unit: "parse", evidence: "def parse(a):" })
  })

  it("never raises the security level", async () => {
    const risk = await assess({ ...PY_LIBRARY, "pkg/api.py": "def parse(a):\n    return a\n", "pkg/run.py": "from pkg.api import parse\n\ndef run():\n    return parse(1)\n" }, { "pkg/api.py": "def parse(a, b):\n    return a\n" })
    expect(risk.findings.filter((finding) => finding.category === RiskCategory.BreakingChange).map((finding) => finding.severity)).toEqual([RiskSeverity.High])
    expect(risk.securityLevel).toBe(RiskSeverity.Low)
  })
})

interface MigrationCase {
  readonly name: string
  readonly path: string
  readonly content: string
  readonly expected: readonly string[]
}

const FLAGGED_MIGRATIONS: readonly MigrationCase[] = [
  { name: "sql: drop table", path: "migrations/1_x.sql", content: "DROP TABLE users;\n", expected: ["Migration drops table users"] },
  { name: "sql: drop table quoted, with a schema", path: "migrations/1_x.sql", content: 'DROP TABLE IF EXISTS public."users";\n', expected: ["Migration drops table users"] },
  { name: "sql: drop column", path: "db/migrations/1_x.sql", content: "ALTER TABLE users DROP COLUMN email;\n", expected: ["Migration drops column email"] },
  { name: "sql: drop column on its own line", path: "migrations/1_x.sql", content: "ALTER TABLE users\n  DROP COLUMN IF EXISTS email;\n", expected: ["Migration drops column email"] },
  { name: "sql: rename column", path: "migrations/1_x.sql", content: "ALTER TABLE users RENAME COLUMN email TO mail;\n", expected: ["Migration renames column email"] },
  { name: "sql: rename table", path: "migrations/1_x.sql", content: "ALTER TABLE users RENAME TO accounts;\n", expected: ["Migration renames table users"] },
  { name: "sql: changed type", path: "migrations/1_x.sql", content: "ALTER TABLE users ALTER COLUMN age TYPE bigint;\n", expected: ["Migration changes the type of column age"] },
  { name: "sql: mysql modify", path: "migrations/1_x.sql", content: "ALTER TABLE users MODIFY COLUMN age bigint;\n", expected: ["Migration changes the type of column age"] },
  { name: "prisma", path: "prisma/migrations/20240101_x/migration.sql", content: '-- DropTable\nDROP TABLE "Session";\n', expected: ["Migration drops table Session"] },
  { name: "goose up section", path: "migrations/1_x.sql", content: "-- +goose Up\nDROP TABLE users;\n-- +goose Down\nCREATE TABLE audit (id int);\n", expected: ["Migration drops table users"] },
  { name: "alembic: drop column", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.drop_column("users", "email")\n', expected: ["Migration drops column email"] },
  { name: "alembic: batch drop column", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    with op.batch_alter_table("users") as batch_op:\n        batch_op.drop_column("email")\n', expected: ["Migration drops column email"] },
  { name: "alembic: drop table", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.drop_table("users")\n', expected: ["Migration drops table users"] },
  { name: "alembic: rename column", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.alter_column("users", "email", new_column_name="mail")\n', expected: ["Migration renames column email"] },
  { name: "alembic: changed type", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.alter_column("users", "age", type_=sa.BigInteger())\n', expected: ["Migration changes the type of column age"] },
  { name: "alembic: raw sql", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.execute("DROP TABLE users")\n', expected: ["Migration drops table users"] },
  { name: "django: delete model", path: "app/migrations/0002_x.py", content: 'class Migration:\n    operations = [\n        migrations.DeleteModel(\n            name="Book",\n        ),\n    ]\n', expected: ["Migration drops table Book"] },
  { name: "django: remove field", path: "app/migrations/0002_x.py", content: 'class Migration:\n    operations = [\n        migrations.RemoveField(\n            model_name="book",\n            name="title",\n        ),\n    ]\n', expected: ["Migration drops column title"] },
  { name: "django: rename field", path: "app/migrations/0002_x.py", content: 'class Migration:\n    operations = [\n        migrations.RenameField(\n            model_name="book",\n            old_name="title",\n            new_name="name",\n        ),\n    ]\n', expected: ["Migration renames column title"] },
  { name: "rails: remove column", path: "db/migrate/1_x.rb", content: "class X < ActiveRecord::Migration[7.0]\n  def change\n    remove_column :users, :email, :string\n  end\nend\n", expected: ["Migration drops column email"] },
  { name: "rails: drop table", path: "db/migrate/1_x.rb", content: "class X < ActiveRecord::Migration[7.0]\n  def up\n    drop_table :users\n  end\nend\n", expected: ["Migration drops table users"] },
  { name: "rails: rename column", path: "db/migrate/1_x.rb", content: "class X\n  def change\n    rename_column :users, :email, :mail\n  end\nend\n", expected: ["Migration renames column email"] },
  { name: "rails: change column", path: "db/migrate/1_x.rb", content: "class X\n  def up\n    change_column :users, :age, :bigint\n  end\nend\n", expected: ["Migration changes the type of column age"] },
  { name: "knex: drop column", path: "migrations/1_x.js", content: 'exports.up = (knex) => knex.schema.alterTable("users", (t) => {\n  t.dropColumn("email")\n})\n', expected: ["Migration drops column email"] },
  { name: "sequelize: remove column", path: "migrations/1_x.js", content: 'module.exports = {\n  up: (q) => q.removeColumn("users", "email"),\n}\n', expected: ["Migration drops column email"] },
  { name: "rails: post-deployment folder (mastodon/mastodon#40236)", path: "db/post_migrate/1_x.rb", content: "class X\n  def change\n    safety_assured { remove_column :accounts, :private_key, :text }\n  end\nend\n", expected: ["Migration drops column private_key"] },
  { name: "typeorm: raw sql", path: "src/migrations/1_x.ts", content: 'export class X {\n  async up(q) {\n    await q.query(`ALTER TABLE "users" DROP COLUMN "email"`)\n  }\n}\n', expected: ["Migration drops column email"] },
]

const NOT_FLAGGED_MIGRATIONS: readonly MigrationCase[] = [
  { name: "a comment", path: "migrations/1_x.sql", content: "-- DROP TABLE users;\nSELECT 1;\n", expected: [] },
  { name: "not in a migration folder", path: "sql/cleanup.sql", content: "DROP TABLE users;\n", expected: [] },
  { name: "test fixture", path: "tests/migrations/1_x.sql", content: "DROP TABLE users;\n", expected: [] },
  { name: "a rollback file", path: "migrations/1_x.down.sql", content: "DROP TABLE users;\n", expected: [] },
  { name: "flyway undo", path: "migrations/U1__x.sql", content: "DROP TABLE users;\n", expected: [] },
  { name: "goose down section", path: "migrations/1_x.sql", content: "-- +goose Up\nCREATE TABLE audit (id int);\n-- +goose Down\nDROP TABLE audit;\nDROP TABLE users;\n", expected: [] },
  { name: "dbmate down section", path: "migrations/1_x.sql", content: "-- migrate:up\nSELECT 1;\n-- migrate:down\nDROP TABLE users;\n", expected: [] },
  { name: "alembic downgrade", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.add_column("users", sa.Column("age"))\n\ndef downgrade():\n    op.drop_column("users", "email")\n', expected: [] },
  { name: "rails down", path: "db/migrate/1_x.rb", content: "class X\n  def up\n    add_column :users, :age, :int\n  end\n  def down\n    remove_column :users, :email\n  end\nend\n", expected: [] },
  { name: "knex down", path: "migrations/1_x.js", content: 'exports.up = (knex) => knex.raw("SELECT 1")\nexports.down = (knex) => knex.schema.dropTable("users")\n', expected: [] },
  { name: "created earlier in the same change", path: "migrations/1_x.sql", content: "CREATE TABLE staging (id int);\nINSERT INTO audit SELECT * FROM staging;\nDROP TABLE staging;\n", expected: [] },
  { name: "column added earlier in the same change", path: "migrations/1_x.sql", content: "ALTER TABLE users ADD COLUMN scratch int;\nALTER TABLE users DROP COLUMN scratch;\n", expected: [] },
  { name: "table rebuilt", path: "migrations/1_x.sql", content: 'CREATE TABLE "new_users" (id int);\nDROP TABLE "users";\nALTER TABLE "new_users" RENAME TO "users";\n', expected: [] },
  { name: "temporary table", path: "migrations/1_x.sql", content: "DROP TABLE tmp_users;\nDROP TABLE users_backup;\n", expected: [] },
  { name: "dropping something else", path: "migrations/1_x.sql", content: "DROP INDEX users_email;\nALTER TABLE users DROP CONSTRAINT users_pk;\nALTER TABLE users ALTER COLUMN age SET NOT NULL;\n", expected: [] },
  { name: "django: field replaced under the same name (netbox-community/netbox#23393)", path: "app/migrations/0002_x.py", content: 'class Migration:\n    operations = [\n        migrations.RemoveField(\n            model_name="cable",\n            name="_abs_length",\n        ),\n        migrations.AddField(\n            model_name="cable",\n            name="_abs_length",\n            field=models.GeneratedField(),\n        ),\n    ]\n', expected: [] },
  { name: "rails: column replaced under the same name", path: "db/migrate/1_x.rb", content: "class X\n  def change\n    remove_column :users, :age\n    add_column :users, :age, :bigint\n  end\nend\n", expected: [] },
  { name: "alembic: column replaced under the same name", path: "alembic/versions/1_x.py", content: 'def upgrade():\n    op.drop_column("users", "age")\n    op.add_column("users", sa.Column("age", sa.BigInteger()))\n', expected: [] },
  { name: "adding only", path: "migrations/1_x.sql", content: "CREATE TABLE users (id int);\nALTER TABLE users ADD COLUMN age int;\n", expected: [] },
]

describe("database migrations", () => {
  it.each([...FLAGGED_MIGRATIONS, ...NOT_FLAGGED_MIGRATIONS])("$name", async ({ path, content, expected }) => {
    expect(await flagged({ "README.md": "x\n" }, { [path]: content })).toEqual(expected)
  })

  it("reports one column dropped from several tables once per file", async () => {
    expect(await flagged({ "README.md": "x\n" }, { "migrations/1_x.sql": "ALTER TABLE a DROP COLUMN total;\nALTER TABLE b DROP COLUMN total;\n" })).toEqual(["Migration drops column total"])
  })

  it("doesn't blame a PR for what an edited migration already held", async () => {
    const before = "DROP TABLE users;\nSELECT 1;\n"
    expect(await flagged({ "migrations/1_x.sql": before }, { "migrations/1_x.sql": `${before}SELECT 2;\n` })).toEqual([])
  })

  it.each([
    { name: "an unusual name still in code is serious", column: "legacy_email", severity: RiskSeverity.High, mentions: true },
    { name: "a common word in code proves little", column: "email", severity: RiskSeverity.Medium, mentions: true },
    { name: "an unusual name not in code is worth a look", column: "other_email", severity: RiskSeverity.Medium, mentions: false },
  ])("$name", async ({ column, severity, mentions }) => {
    const risk = await assess({ "src/app.py": "def read(row):\n    return row['legacy_email'], row['email']\n" }, { "migrations/1_x.sql": `ALTER TABLE users DROP COLUMN ${column};\n` })
    const finding = risk.findings.find((candidate) => candidate.category === RiskCategory.BreakingChange)
    expect(finding).toMatchObject({ severity, location: { path: "migrations/1_x.sql", line: 1 } })
    expect(finding?.detail.includes("src/app.py:2")).toBe(mentions)
  })
})

interface ConfigCase {
  readonly name: string
  readonly before: Files
  readonly after: Files
  readonly expected: readonly string[]
}

const READS_API_URL: Files = { "src/app.py": 'import os\nURL = os.environ["API_URL"]\n' }

const CONFIG_CASES: readonly ConfigCase[] = [
  { name: "env file: renamed by value", before: { ".env.example": "API_URL=http://x\n" }, after: { ".env.example": "SERVICE_ENDPOINT=http://x\n" }, expected: ["Environment variable API_URL was renamed to SERVICE_ENDPOINT"] },
  { name: "env file: renamed by name", before: { ".env.example": "DATABASE_URL=a\n" }, after: { ".env.example": "DB_URL=b\n" }, expected: ["Environment variable DATABASE_URL was renamed to DB_URL"] },
  { name: "env file: removed, code still needs it", before: { ...READS_API_URL, ".env.example": "API_URL=x\nOTHER=y\n" }, after: { ".env.example": "OTHER=y\n" }, expected: ["Environment variable API_URL was removed from .env.example"] },
  { name: "env file: other spellings", before: { ...READS_API_URL, "config/env.sample": "API_URL=x\n", "web.env": "export API_URL=x\n" }, after: { "config/env.sample": "\n", "web.env": "\n" }, expected: ["Environment variable API_URL was removed from config/env.sample", "Environment variable API_URL was removed from web.env"] },
  { name: "env file: removed, nothing reads it", before: { "src/app.py": "URL = 1\n", ".env.example": "API_URL=x\nOTHER=y\n" }, after: { ".env.example": "OTHER=y\n" }, expected: [] },
  { name: "env file: removed, read has a default", before: { "src/app.py": 'import os\nURL = os.getenv("API_URL", "x")\n', ".env.example": "API_URL=x\nOTHER=y\n" }, after: { ".env.example": "OTHER=y\n" }, expected: [] },
  { name: "env file: removed, ts read has a default", before: { "src/app.ts": 'export const url = process.env.API_URL ?? "x"\n', ".env.example": "API_URL=x\nOTHER=y\n" }, after: { ".env.example": "OTHER=y\n" }, expected: [] },
  { name: "env file: only commented out", before: { ...READS_API_URL, ".env.example": "API_URL=x\n" }, after: { ".env.example": "# API_URL=x\n" }, expected: [] },
  { name: "env file: moved within the file", before: { ...READS_API_URL, ".env.example": "API_URL=x\nOTHER=y\n" }, after: { ".env.example": "OTHER=y\nAPI_URL=x\n" }, expected: [] },
  { name: "env file: value changed", before: { ".env.example": "API_URL=x\n" }, after: { ".env.example": "API_URL=y\n" }, expected: [] },
  { name: "env file: unrelated replacement isn't a rename", before: { ".env.example": "API_URL=x\n" }, after: { ".env.example": "THEME=dark\n" }, expected: [] },
  { name: "env file: neighbours sharing a prefix aren't a rename (supabase/supabase#51619)", before: { "apps/kb/.env.example": "PUBLIC_SUPABASE_ANON_KEY=a\n" }, after: { "apps/kb/.env.example": "SUPABASE_URL=b\n" }, expected: [] },
  { name: "env file: empty values prove nothing, and order doesn't matter (supabase/supabase#51619)", before: { ".env.example": "OLD_URL=\nOLD_KEY=\n" }, after: { ".env.example": "NEW_KEY=\nNEW_URL=\n" }, expected: ["Environment variable OLD_URL was renamed to NEW_URL", "Environment variable OLD_KEY was renamed to NEW_KEY"] },
  { name: "ci: reads in a monorepo's projects don't count (supabase/supabase#51619)", before: { "apps/docs/lib.py": 'import os\nA = os.environ["API_URL"]\n', ".github/workflows/ci.yml": "env:\n  API_URL: x\n  OTHER: y\n" }, after: { ".github/workflows/ci.yml": "env:\n  OTHER: y\n" }, expected: [] },
  { name: "env file: another app reading the name has its own settings (supabase/supabase#51619)", before: { "apps/docs/lib.py": 'import os\nA = os.environ["API_URL"]\n', "apps/kb/.env.example": "API_URL=x\nOTHER=y\n" }, after: { "apps/kb/.env.example": "OTHER=y\n" }, expected: [] },
  { name: "env file: added only", before: { ".env.example": "API_URL=x\n" }, after: { ".env.example": "API_URL=x\nOTHER=y\n" }, expected: [] },
  { name: "ci: removed, code still needs it", before: { ...READS_API_URL, ".github/workflows/ci.yml": "jobs:\n  a:\n    env:\n      API_URL: x\n      OTHER: y\n" }, after: { ".github/workflows/ci.yml": "jobs:\n  a:\n    env:\n      OTHER: y\n" }, expected: ["Environment variable API_URL was removed from .github/workflows/ci.yml"] },
  { name: "ci: gitlab removed, code still needs it", before: { ...READS_API_URL, ".gitlab-ci.yml": "variables:\n  API_URL: x\n" }, after: { ".gitlab-ci.yml": "variables:\n  OTHER: x\n" }, expected: ["Environment variable API_URL was removed from .gitlab-ci.yml"] },
  { name: "ci: compose list form", before: { ...READS_API_URL, "docker-compose.yml": "services:\n  a:\n    environment:\n      - API_URL=x\n      - OTHER=y\n" }, after: { "docker-compose.yml": "services:\n  a:\n    environment:\n      - OTHER=y\n" }, expected: ["Environment variable API_URL was removed from docker-compose.yml"] },
  { name: "ci: removed, nothing reads it", before: { ".github/workflows/ci.yml": "env:\n  API_URL: x\n  OTHER: y\n" }, after: { ".github/workflows/ci.yml": "env:\n  OTHER: y\n" }, expected: [] },
  { name: "ci: rename is self-contained", before: { ".github/workflows/ci.yml": "env:\n  API_URL: x\n" }, after: { ".github/workflows/ci.yml": "env:\n  SERVICE_URL: x\n" }, expected: [] },
  { name: "ci: ordinary keys aren't variables", before: { ...READS_API_URL, ".github/workflows/ci.yml": "jobs:\n  a:\n    name: x\n    timeout: 3\n" }, after: { ".github/workflows/ci.yml": "jobs:\n  a:\n    timeout: 3\n" }, expected: [] },
  { name: "code: reads a new variable instead", before: { "src/app.py": 'import os\nURL = os.environ["API_URL"]\n' }, after: { "src/app.py": 'import os\nURL = os.environ["SERVICE_URL"]\n' }, expected: ["Environment variable API_URL was renamed to SERVICE_URL"] },
  { name: "code: typescript", before: { "src/app.ts": "export const url = process.env.API_URL\n" }, after: { "src/app.ts": "export const url = process.env.SERVICE_URL\n" }, expected: ["Environment variable API_URL was renamed to SERVICE_URL"] },
  { name: "code: rust", before: { "src/main.rs": 'fn main() {\n    let url = std::env::var("API_URL");\n}\n' }, after: { "src/main.rs": 'fn main() {\n    let url = std::env::var("SERVICE_URL");\n}\n' }, expected: ["Environment variable API_URL was renamed to SERVICE_URL"] },
  { name: "code: env file and code say the same thing once", before: { "src/app.py": 'import os\nURL = os.environ["API_URL"]\n', ".env.example": "API_URL=x\n" }, after: { "src/app.py": 'import os\nURL = os.environ["SERVICE_URL"]\n', ".env.example": "SERVICE_URL=x\n" }, expected: ["Environment variable API_URL was renamed to SERVICE_URL"] },
  { name: "code: new read has a fallback", before: { "src/app.py": 'import os\nURL = os.environ["API_URL"]\n' }, after: { "src/app.py": 'import os\nURL = os.getenv("SERVICE_URL", "x")\n' }, expected: [] },
  { name: "code: old name is still read elsewhere", before: { "src/app.py": 'import os\nURL = os.environ["API_URL"]\n', "src/other.py": 'import os\nA = os.environ["API_URL"]\n' }, after: { "src/app.py": 'import os\nURL = os.environ["SERVICE_URL"]\n' }, expected: [] },
  { name: "code: another app still reads the old name", before: { "apps/kb/app.py": 'import os\nURL = os.environ["API_URL"]\n', "apps/docs/app.py": 'import os\nA = os.environ["API_URL"]\n' }, after: { "apps/kb/app.py": 'import os\nURL = os.environ["SERVICE_URL"]\n' }, expected: ["Environment variable API_URL was renamed to SERVICE_URL"] },
  { name: "ci: reads in examples don't count (supabase/supabase#51619)", before: { "examples/app/lib.py": 'import os\nA = os.environ["API_URL"]\n', ".github/workflows/ci.yml": "env:\n  API_URL: x\n  OTHER: y\n" }, after: { ".github/workflows/ci.yml": "env:\n  OTHER: y\n" }, expected: [] },
  { name: "code: read removed with nothing in its place", before: { "src/app.py": 'import os\nURL = os.environ["API_URL"]\nA = 1\n' }, after: { "src/app.py": "import os\nA = 1\n" }, expected: [] },
  { name: "config: key removed, code still reads it", before: { "src/app.py": 'def run(config):\n    return config["max_retries"]\n', "config/app.yml": "max_retries: 3\nother: 1\n" }, after: { "config/app.yml": "other: 1\n" }, expected: ["Config key max_retries was removed in config/app.yml"] },
  { name: "config: key renamed, code still reads it", before: { "src/app.ts": "export const a = config.maxRetries\n", "config/app.json": '{\n  "maxRetries": 3\n}\n' }, after: { "config/app.json": '{\n  "retryLimit": 3\n}\n' }, expected: ["Config key maxRetries was renamed to retryLimit in config/app.json"] },
  { name: "config: toml", before: { "src/app.py": 'def run(config):\n    return config.get("max_retries")\n', "settings.toml": "max_retries = 3\nother = 1\n" }, after: { "settings.toml": "other = 1\n" }, expected: ["Config key max_retries was removed in settings.toml"] },
  { name: "config: key removed, nothing reads it", before: { "src/app.py": "A = 1\n", "config/app.yml": "max_retries: 3\nother: 1\n" }, after: { "config/app.yml": "other: 1\n" }, expected: [] },
  { name: "config: too common a word to trust", before: { "src/app.py": 'def run(config):\n    return config["name"]\n', "config/app.yml": "name: 3\nother: 1\n" }, after: { "config/app.yml": "other: 1\n" }, expected: [] },
  { name: "config: name only appears as an ordinary variable", before: { "src/app.py": "max_retries = 1\n", "config/app.yml": "max_retries: 3\nother: 1\n" }, after: { "config/app.yml": "other: 1\n" }, expected: [] },
  { name: "config: not a config file", before: { "src/app.py": 'def run(config):\n    return config["max_retries"]\n', "data/rows.yml": "max_retries: 3\nother: 1\n" }, after: { "data/rows.yml": "other: 1\n" }, expected: [] },
]

describe("configuration and environment", () => {
  it.each(CONFIG_CASES)("$name", async ({ before, after, expected }) => {
    expect(await flagged(before, after)).toEqual(expected)
  })

  it("says who still reads a removed variable", async () => {
    const risk = await assess({ ...READS_API_URL, ".env.example": "API_URL=x\nOTHER=y\n" }, { ".env.example": "OTHER=y\n" })
    const finding = risk.findings.find((candidate) => candidate.category === RiskCategory.BreakingChange)
    expect(finding).toMatchObject({ ruleId: "breaking.env-removed", severity: RiskSeverity.Medium, location: { path: ".env.example", line: null }, evidence: "API_URL=x" })
    expect(finding?.detail).toContain("src/app.py:2")
  })
})
