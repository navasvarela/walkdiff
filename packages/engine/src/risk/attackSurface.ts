import { codeSpan, isTestPath, RiskCategory, RiskSeverity, SourceLanguage } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import type { Tree } from "web-tree-sitter"
import { languageSpecFor } from "../syntax/languages.ts"
import { withSyntaxTree } from "../syntax/parser.ts"
import { isInsideCommentOrString } from "./codePositions.ts"
import { addedLines, findingAt, isThirdParty, removedLines } from "./scannedFile.ts"
import type { RuleDescription, ScannedFile } from "./scannedFile.ts"

/**
 * What a change makes reachable from outside: new HTTP endpoints, whether they keep the auth
 * their neighbours declare, and code that opts out of auth or CSRF checks. Routes are read by
 * pattern from the lines a PR adds, so a framework that registers routes some other way is missed;
 * a missed route costs a note, while a wrong one would cost trust.
 */

/** Where a route's auth is declared, which says which lines to look for it on. */
const RouteForm = {
  /** `router.get("/users", requireAuth, list)`: in the same call, so only on the route's own line. */
  Call: "call",
  /** `@app.get("/users")`: in the decorators above it, or the signature just below. */
  Decorator: "decorator",
} as const
type RouteForm = (typeof RouteForm)[keyof typeof RouteForm]

interface RouteSyntax {
  readonly form: RouteForm
  readonly languages: ReadonlySet<SourceLanguage>
  /** Named groups: `path`, and `method` when the syntax names one. */
  readonly pattern: RegExp
}

interface Route {
  readonly method: string
  readonly path: string
  readonly line: number
  /** An auth marker sits on the route's own declaration: a decorator, attribute or middleware argument. */
  readonly guarded: boolean
}

const ECMASCRIPT: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.TypeScript, SourceLanguage.Tsx])
const PYTHON: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Python])
const JVM: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Java, SourceLanguage.Kotlin])
const CSHARP: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.CSharp])
const GO: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Go])
const RUST: ReadonlySet<SourceLanguage> = new Set([SourceLanguage.Rust])

const ROUTE_SYNTAXES: readonly RouteSyntax[] = [
  // Express, Koa, Fastify and Hono: `router.post("/users", …)`.
  { form: RouteForm.Call, languages: ECMASCRIPT, pattern: /\b(?:app|router|server|api|routes|fastify|hono)\.(?<method>get|post|put|patch|delete|all)\s*\(\s*["'`](?<path>[^"'`]+)/ },
  // NestJS: `@Post("users")`.
  { form: RouteForm.Decorator, languages: ECMASCRIPT, pattern: /@(?<method>Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`](?<path>[^"'`]*))?/ },
  // FastAPI and Flask: `@app.get("/users")`, `@router.post(…)`, `@bp.route(…)`.
  { form: RouteForm.Decorator, languages: PYTHON, pattern: /@\w+\.(?<method>get|post|put|patch|delete|route|api_route)\(\s*["'](?<path>[^"']+)/ },
  // Django: `path("users/", views.users)`.
  { form: RouteForm.Call, languages: PYTHON, pattern: /\b(?:re_)?path\(\s*r?["'](?<path>[^"']*)["']\s*,/ },
  // Spring: `@PostMapping("/users")`, `@RequestMapping(value = "/users")`; JAX-RS: `@Path("/users")`.
  { form: RouteForm.Decorator, languages: JVM, pattern: /@(?<method>Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?[{[]?\s*"(?<path>[^"]*)"/ },
  { form: RouteForm.Decorator, languages: JVM, pattern: /@Path\(\s*"(?<path>[^"]*)"/ },
  // ASP.NET: `[HttpPost("users")]`, and minimal APIs: `app.MapPost("/users", …)`.
  { form: RouteForm.Decorator, languages: CSHARP, pattern: /\[Http(?<method>Get|Post|Put|Patch|Delete)\(\s*"(?<path>[^"]*)"/ },
  { form: RouteForm.Call, languages: CSHARP, pattern: /\.Map(?<method>Get|Post|Put|Patch|Delete)\s*\(\s*"(?<path>[^"]+)"/ },
  // net/http, including Go 1.22's "POST /users" patterns; gin, echo and chi: `r.POST("/users", …)`.
  { form: RouteForm.Call, languages: GO, pattern: /\.(?:HandleFunc|Handle)\s*\(\s*"(?<path>[^"]+)"/ },
  { form: RouteForm.Call, languages: GO, pattern: /\.(?<method>GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\s*\(\s*"(?<path>\/[^"]*)"/ },
  // axum: `.route("/users", post(create))`; actix and Rocket: `#[post("/users")]`.
  { form: RouteForm.Call, languages: RUST, pattern: /\.route\s*\(\s*"(?<path>[^"]+)"\s*,\s*(?<method>get|post|put|patch|delete)\b/ },
  { form: RouteForm.Decorator, languages: RUST, pattern: /#\[(?<method>get|post|put|patch|delete)\s*\(\s*"(?<path>[^"]+)"/ },
]

// Code that turns auth or CSRF checks off for what it decorates.
const AUTH_OPT_OUT = /\[AllowAnonymous\]|\.permitAll\s*\(|@PermitAll\b|\bAllowAny\b|@csrf_exempt\b|@Public\s*\(\s*\)/
// Words an auth check is usually named with, in decorators, attributes and middleware. "auth" counts
// in requireAuth, isAuthenticated and [Authorize], but not in "author" or "authority".
const AUTH_MARKER = /auth(?!or(?!i[sz]))|login_required|permission|guard|current_?user|jwt|protect|secured|roles_?allowed|verify_?token|logged_?in|require_?user/i
const QUOTED_TEXT = /(["'`])(?:\\.|(?!\1).)*\1/g
// A decorator-style route's auth sits among the decorators or attributes stacked with it, or in the
// signature they decorate, such as FastAPI's `Depends(get_current_user)`. The stack ends at the first
// line that isn't one, so a neighbouring route's markers don't count. The caps only bound a long stack.
const DECORATOR_LINE = /^\s*(?:@|\[|#\[)/
const MAX_STACK_LINES = 6
// Fewer neighbours than this say little about the file's habits.
const MIN_GUARDED_NEIGHBOURS = 2
const ANY_METHOD = "ANY"
// Methods that aren't a request's method: `route` and `all` accept any, `request` sets none.
const METHODLESS: ReadonlySet<string> = new Set(["ROUTE", "API_ROUTE", "ALL", "REQUEST"])
const GO_METHOD_IN_PATTERN = /^(?<method>[A-Z]+)\s+(?<path>\/.*)$/

const NEW_ENDPOINT: RuleDescription = {
  id: "endpoint.added",
  category: RiskCategory.AttackSurface,
  severity: RiskSeverity.Low,
  title: "New endpoint",
  detail: "Reachable from outside the service. Check who can call it, what it trusts from the request, and how much work one call can cause.",
}
const UNGUARDED_ENDPOINT: RuleDescription = {
  id: "endpoint.unguarded",
  category: RiskCategory.AttackSurface,
  severity: RiskSeverity.Medium,
  title: "New endpoint without the auth its neighbours use",
  detail: "The other routes in this file check authentication or permissions where they're declared, and this one doesn't. If it's meant to be public, say so in the PR.",
}
const AUTH_OPT_OUT_RULE: RuleDescription = {
  id: "endpoint.auth-opt-out",
  category: RiskCategory.AttackSurface,
  severity: RiskSeverity.Medium,
  title: "Turns off an auth or CSRF check",
  detail: "Whatever this decorates can be called without the checks the rest of the app applies. Check that's intended, and that nothing behind it assumes a signed-in user.",
}

export async function scanAttackSurface(files: readonly ScannedFile[]): Promise<Risk[]> {
  const removedRoutes = new Set(files.flatMap((file) => routesOnLines(file, removedLines(file.diff))).map(routeKey))
  const findings: Risk[] = []
  for (const file of files) {
    const spec = languageSpecFor(file.diff.path)
    if (spec === undefined || file.after === undefined || isThirdParty(file) || isTestPath(file.diff.path)) continue
    const added = new Set(addedLines(file.diff).map((line) => line.line))
    if (added.size === 0) continue
    const syntaxes = ROUTE_SYNTAXES.filter((syntax) => syntax.languages.has(spec.language))
    const source = file.after
    findings.push(...(await withSyntaxTree(spec, source, (tree) => findingsIn(tree, source, syntaxes, added, removedRoutes, file.diff.path))))
  }
  return findings
}

function findingsIn(tree: Tree, source: string, syntaxes: readonly RouteSyntax[], added: ReadonlySet<number>, removedRoutes: ReadonlySet<string>, path: string): Risk[] {
  const lines = source.split("\n")
  const routes = lines.flatMap((content, index) => routeOn(tree, content, index, syntaxes, lines))
  const neighbours = routes.filter((route) => !added.has(route.line))
  const neighboursGuarded = neighbours.length >= MIN_GUARDED_NEIGHBOURS && neighbours.every((route) => route.guarded)
  const fresh = routes.filter((route) => added.has(route.line) && !removedRoutes.has(routeKey(route)))
  const endpointFindings = fresh.map((route) => {
    const rule = neighboursGuarded && !route.guarded ? UNGUARDED_ENDPOINT : NEW_ENDPOINT
    return findingAt({ ...rule, title: `${rule.title}: ${codeSpan(`${route.method} ${route.path}`)}` }, path, route.line, lines.at(route.line - 1) ?? null)
  })
  return [...endpointFindings, ...optOutsIn(tree, lines, added, path)]
}

function routeOn(tree: Tree, content: string, index: number, syntaxes: readonly RouteSyntax[], lines: readonly string[]): Route[] {
  for (const syntax of syntaxes) {
    const match = syntax.pattern.exec(content)
    if (match === null || isInsideCommentOrString(tree, index, match.index)) continue
    const window = authWindow(lines, index, syntax.form).replace(QUOTED_TEXT, "")
    return [{ ...methodAndPath(match.groups), line: index + 1, guarded: AUTH_MARKER.test(window) }]
  }
  return []
}

function authWindow(lines: readonly string[], index: number, form: RouteForm): string {
  const own = lines.at(index) ?? ""
  if (form === RouteForm.Call) return own
  const above: string[] = []
  for (let row = index - 1; row >= 0 && above.length < MAX_STACK_LINES && DECORATOR_LINE.test(lines.at(row) ?? ""); row--) above.unshift(lines.at(row) ?? "")
  const below: string[] = []
  for (let row = index + 1; row < lines.length && below.length < MAX_STACK_LINES; row++) {
    const line = lines.at(row) ?? ""
    below.push(line)
    if (!DECORATOR_LINE.test(line)) break
  }
  return [...above, own, ...below].join("\n")
}

function methodAndPath(groups: Record<string, string | undefined> | undefined): { method: string; path: string } {
  const path = groups?.path ?? ""
  const method = groups?.method?.toUpperCase()
  // Go 1.22 puts the method in the pattern: "POST /users".
  const inPattern = GO_METHOD_IN_PATTERN.exec(path)?.groups
  if (method === undefined && inPattern !== undefined) return { method: inPattern.method ?? ANY_METHOD, path: inPattern.path ?? path }
  return { method: method === undefined || METHODLESS.has(method) ? ANY_METHOD : method, path: path === "" ? "/" : path }
}

// Removed lines are matched without a syntax tree: the base version isn't parsed here, and a route
// that moved within the PR only needs its method and path recognised.
function routesOnLines(file: ScannedFile, lines: readonly { readonly line: number; readonly content: string }[]): Route[] {
  const spec = languageSpecFor(file.diff.path)
  if (spec === undefined) return []
  const syntaxes = ROUTE_SYNTAXES.filter((syntax) => syntax.languages.has(spec.language))
  return lines.flatMap(({ line, content }) => {
    const match = syntaxes.map((syntax) => syntax.pattern.exec(content)).find((candidate) => candidate !== null)
    return match === undefined || match === null ? [] : [{ ...methodAndPath(match.groups), line, guarded: false }]
  })
}

function routeKey(route: Route): string {
  return `${route.method} ${route.path}`
}

function optOutsIn(tree: Tree, lines: readonly string[], added: ReadonlySet<number>, path: string): Risk[] {
  return [...added].sort((a, b) => a - b).flatMap((line) => {
    const content = lines.at(line - 1) ?? ""
    const match = AUTH_OPT_OUT.exec(content)
    return match === null || isInsideCommentOrString(tree, line - 1, match.index) ? [] : [findingAt(AUTH_OPT_OUT_RULE, path, line, content)]
  })
}
