import { RiskCategory, RiskSeverity, SourceLanguage } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import type { Tree } from "web-tree-sitter"
import { languageSpecFor } from "../syntax/languages.ts"
import { withSyntaxTree } from "../syntax/parser.ts"
import { addedLines, findingAt, isThirdParty } from "./scannedFile.ts"
import type { AddedLine, RuleDescription, ScannedFile } from "./scannedFile.ts"

interface ApiRule extends RuleDescription {
  readonly languages: ReadonlySet<SourceLanguage>
  readonly pattern: RegExp
  /** Text on the same line that makes the use safe, such as an explicit safe loader. */
  readonly safeWhen?: RegExp
}

const ECMASCRIPT: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.TypeScript, SourceLanguage.Tsx])
const PYTHON: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Python])
const RUST: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Rust])
const GO: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Go])
const JAVA: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Java])
const C_FAMILY: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.C, SourceLanguage.Cpp])
const CPP: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Cpp])

function rule(
  id: string,
  languages: ReadonlySet<SourceLanguage>,
  severity: RiskSeverity,
  pattern: RegExp,
  title: string,
  detail: string,
): ApiRule {
  return { id, languages, severity, pattern, title, detail, category: RiskCategory.DangerousApi }
}

const CODE_EXECUTION = "Runs a string as code. If any part of it can come from users or files, it is a code-injection hole."
const TLS_DISABLED = "Turns off certificate checks, so anyone on the network path can read or alter the traffic."
const SQL_INTERPOLATION = "SQL assembled from interpolated values is open to injection. Use bound parameters instead."
const SPAWNS_PROCESSES = "Check that no user input reaches the command or its arguments unchecked."

const API_RULES: readonly ApiRule[] = [
  rule("js.eval", ECMASCRIPT, RiskSeverity.High, /\beval\s*\(/, "eval()", CODE_EXECUTION),
  rule("js.new-function", ECMASCRIPT, RiskSeverity.High, /\bnew\s+Function\s*\(/, "new Function()", CODE_EXECUTION),
  rule("js.child-process", ECMASCRIPT, RiskSeverity.Medium, /\bchild_process\b/, "Spawns processes", "Check that no user input reaches the command or its arguments unescaped."),
  rule("js.raw-html", ECMASCRIPT, RiskSeverity.Medium, /\.(?:inner|outer)HTML\s*=|\bdangerouslySetInnerHTML\b|\binsertAdjacentHTML\s*\(/, "Writes raw HTML", "Unescaped HTML from user data enables cross-site scripting."),
  rule("js.sql-template", ECMASCRIPT, RiskSeverity.Medium, /\b(?:query|execute|raw|unsafe)\s*\(\s*`[^`]*\$\{/, "SQL from a template literal", SQL_INTERPOLATION),
  rule("js.tls-disabled", ECMASCRIPT, RiskSeverity.High, /\brejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, "TLS verification disabled", TLS_DISABLED),
  rule("python.eval", PYTHON, RiskSeverity.High, /(?<![.\w])(?:eval|exec)\s*\(/, "eval() / exec()", CODE_EXECUTION),
  rule("python.subprocess-shell", PYTHON, RiskSeverity.High, /\bshell\s*=\s*True\b/, "Subprocess with shell=True", "The command goes through a shell, so user input in it can run arbitrary commands."),
  rule("python.os-system", PYTHON, RiskSeverity.High, /\bos\.(?:system|popen)\s*\(/, "os.system() / os.popen()", "Runs a shell command; user input in it can run arbitrary commands."),
  rule("python.pickle", PYTHON, RiskSeverity.Medium, /\b(?:pickle|cPickle|dill)\.loads?\s*\(/, "Unpickling", "Loading a pickle runs code embedded in it; never unpickle data from untrusted sources."),
  {
    ...rule("python.yaml-load", PYTHON, RiskSeverity.Medium, /\byaml\.(?:load|load_all)\s*\(/, "yaml.load() without a safe loader", "PyYAML's full loader can construct arbitrary objects; use yaml.safe_load."),
    safeWhen: /SafeLoader|CSafeLoader/,
  },
  rule("python.tls-disabled", PYTHON, RiskSeverity.High, /\bverify\s*=\s*False\b/, "TLS verification disabled", TLS_DISABLED),
  rule("python.sql-format", PYTHON, RiskSeverity.Medium, /\.execute(?:many)?\s*\(\s*(?:f["']|["'][^"']*["']\s*(?:%|\.format\())/, "SQL from string formatting", SQL_INTERPOLATION),
  rule("rust.unsafe", RUST, RiskSeverity.Medium, /\bunsafe\s*(?:\{|fn\b|impl\b|trait\b)/, "unsafe code", "The compiler no longer checks memory safety here; review the invariants the code relies on."),
  rule("rust.transmute", RUST, RiskSeverity.Medium, /\b(?:mem::)?transmute\s*(?:::<|\()/, "mem::transmute", "Reinterprets memory with no checks; a wrong type or size is undefined behaviour."),
  rule("rust.command", RUST, RiskSeverity.Medium, /\bCommand::new\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
  rule("rust.tls-disabled", RUST, RiskSeverity.High, /\bdanger_accept_invalid_(?:certs|hostnames)\s*\(\s*true/, "TLS verification disabled", TLS_DISABLED),
  rule("go.unsafe", GO, RiskSeverity.Medium, /\bunsafe\.(?:Pointer|Slice|String|StringData|SliceData|Add)\b/, "unsafe pointer use", "Go no longer checks types or bounds here; review the memory layout the code relies on."),
  rule("go.exec", GO, RiskSeverity.Medium, /\bexec\.Command(?:Context)?\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
  rule("go.tls-disabled", GO, RiskSeverity.High, /\bInsecureSkipVerify\s*:\s*true\b/, "TLS verification disabled", TLS_DISABLED),
  rule("go.unescaped-template", GO, RiskSeverity.Medium, /\btemplate\.(?:HTML|HTMLAttr|JS|JSStr|CSS|URL)\s*\(/, "Marks text as safe for a template", "html/template won't escape it; if any of it comes from users, that's cross-site scripting."),
  rule("go.sql-format", GO, RiskSeverity.Medium, /\.(?:Query|QueryRow|Exec)(?:Context)?\s*\([^)]*\bfmt\.Sprintf\s*\(/, "SQL from fmt.Sprintf", SQL_INTERPOLATION),
  rule("java.exec", JAVA, RiskSeverity.Medium, /\bgetRuntime\(\)\s*\.exec\s*\(|\bnew\s+ProcessBuilder\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
  rule("java.deserialization", JAVA, RiskSeverity.Medium, /\bnew\s+ObjectInputStream\s*\(/, "Java deserialization", "Reading objects from a stream can run code chosen by whoever wrote it; never deserialize untrusted data."),
  rule("java.sql-concat", JAVA, RiskSeverity.Medium, /\.(?:executeQuery|executeUpdate|execute|prepareStatement|addBatch)\s*\(\s*"[^"]*"\s*\+/, "SQL built by concatenation", SQL_INTERPOLATION),
  rule("java.tls-disabled", JAVA, RiskSeverity.High, /\bNoopHostnameVerifier\b|\bALLOW_ALL_HOSTNAME_VERIFIER\b|\bsetHostnameVerifier\s*\(\s*\([^)]*\)\s*->\s*true\b/, "TLS verification disabled", TLS_DISABLED),
  rule("c.unbounded-copy", C_FAMILY, RiskSeverity.Medium, /\b(?:strcpy|strcat|stpcpy|wcscpy|wcscat|sprintf|vsprintf|gets)\s*\(/, "Unbounded string copy", "Writes with no length limit, so input longer than the buffer overflows it. Use a bounded form such as snprintf."),
  rule("c.format-string", C_FAMILY, RiskSeverity.Medium, /\b(?:printf\s*\(|fprintf\s*\(\s*[\w.>-]+\s*,)\s*[A-Za-z_][\w.>-]*\s*\)/, "Format string from a variable", "If the text can come from users, conversions such as %n and %s in it read or write memory. Print it through \"%s\" instead."),
  rule("c.exec", C_FAMILY, RiskSeverity.Medium, /\b(?:system|popen|exec(?:l|lp|le|v|vp|vpe|ve))\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
  rule("c.tls-disabled", C_FAMILY, RiskSeverity.High, /\bSSL_(?:CTX_)?set_verify\s*\([^,]+,\s*SSL_VERIFY_NONE\b|\bCURLOPT_SSL_VERIFY(?:PEER|HOST)\s*,\s*0/, "TLS verification disabled", TLS_DISABLED),
  rule("cpp.reinterpret-cast", CPP, RiskSeverity.Medium, /\breinterpret_cast\s*</, "reinterpret_cast", "Reinterprets memory with no checks; a wrong type or size is undefined behaviour."),
]

/**
 * Flags risky API uses on added lines of supported languages. A match only counts when it
 * is code: the parsed head file tells comments and strings apart from calls.
 */
export async function scanDangerousApis(files: readonly ScannedFile[]): Promise<Risk[]> {
  const findings: Risk[] = []
  for (const file of files) {
    const spec = languageSpecFor(file.diff.path)
    const rules = API_RULES.filter((candidate) => spec !== undefined && candidate.languages.has(spec.language))
    const lines = addedLines(file.diff)
    if (spec === undefined || file.after === undefined || isThirdParty(file) || rules.length === 0 || lines.length === 0) continue
    const source = file.after
    findings.push(...(await withSyntaxTree(spec, source, (tree) => matchRules(tree, rules, lines, file.diff.path))))
  }
  return findings
}

function matchRules(tree: Tree, rules: readonly ApiRule[], lines: readonly AddedLine[], path: string): Risk[] {
  const findings: Risk[] = []
  for (const { line, content } of lines) {
    for (const apiRule of rules) {
      const match = apiRule.pattern.exec(content)
      if (match === null || apiRule.safeWhen?.test(content) || isInsideCommentOrString(tree, line - 1, match.index)) continue
      findings.push(findingAt(apiRule, path, line, content))
    }
  }
  return findings
}

/**
 * Whether the text at a position is part of a comment or string literal rather than code.
 * Interpolations inside template strings (`${...}`) are code again.
 */
function isInsideCommentOrString(tree: Tree, row: number, column: number): boolean {
  for (let node = tree.rootNode.descendantForPosition({ row, column }); node !== null; node = node.parent) {
    if (node.type === "template_substitution" || node.type === "interpolation") return false
    if (node.type.includes("comment") || node.type.includes("string")) return true
  }
  return false
}
