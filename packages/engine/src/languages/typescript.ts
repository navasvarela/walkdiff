import { RiskSeverity } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { apiRule, CODE_EXECUTION, SQL_INTERPOLATION, TLS_DISABLED } from "../risk/apiRules.ts"
import type { ApiRule } from "../risk/apiRules.ts"
import { ecmascriptSurface } from "../risk/breaking/librarySurface.ts"
import { EMPTY_CATCH_BODY, isEmptyBlock, SWALLOWED } from "../risk/errorHandlers.ts"
import type { HandlerRule } from "../risk/errorHandlers.ts"
import { RouteForm } from "../risk/routeSyntax.ts"
import type { RouteSyntax } from "../risk/routeSyntax.ts"
import type { RuleDescription } from "../risk/scannedFile.ts"
import { tsxSpec, typescriptSpec } from "../syntax/typescript.ts"
import type { Language } from "./language.ts"

// TypeScript, TSX and plain JavaScript are one language to the rules, and import each other freely.
const ECMASCRIPT_FAMILY = "ecmascript"
const NAME = "TypeScript/JavaScript"
const STATEMENT_BLOCK = "statement_block"

const RISKY_APIS: readonly ApiRule[] = [
  apiRule("js.eval", RiskSeverity.High, /\beval\s*\(/, "eval()", CODE_EXECUTION),
  apiRule("js.new-function", RiskSeverity.High, /\bnew\s+Function\s*\(/, "new Function()", CODE_EXECUTION),
  apiRule("js.child-process", RiskSeverity.Medium, /\bchild_process\b/, "Spawns processes", "Check that no user input reaches the command or its arguments unescaped."),
  apiRule("js.raw-html", RiskSeverity.Medium, /\.(?:inner|outer)HTML\s*=|\bdangerouslySetInnerHTML\b|\binsertAdjacentHTML\s*\(/, "Writes raw HTML", "Unescaped HTML from user data enables cross-site scripting."),
  apiRule("js.sql-template", RiskSeverity.Medium, /\b(?:query|execute|raw|unsafe)\s*\(\s*`[^`]*\$\{/, "SQL from a template literal", SQL_INTERPOLATION),
  apiRule("js.tls-disabled", RiskSeverity.High, /\brejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, "TLS verification disabled", TLS_DISABLED),
]

// `promise.catch(() => {})`.
function emptyPromiseCatch(node: Node): RuleDescription | undefined {
  const callee = node.childForFieldName("function")
  if (callee?.type !== "member_expression" || callee.childForFieldName("property")?.text !== "catch") return undefined
  const handler = node.childForFieldName("arguments")?.firstNamedChild
  const isFunction = handler?.type === "arrow_function" || handler?.type === "function_expression"
  // `() => undefined` or `() => fallback` returns a value on purpose; only an empty `{}` does nothing.
  const body = handler?.childForFieldName("body")
  return isFunction && body?.type === STATEMENT_BLOCK && isEmptyBlock(body) ? SWALLOWED : undefined
}

const ERROR_HANDLERS: readonly HandlerRule[] = [EMPTY_CATCH_BODY, { types: ["call_expression"], check: emptyPromiseCatch }]

const ROUTES: readonly RouteSyntax[] = [
  // Express, Koa, Fastify and Hono: `router.post("/users", …)`.
  { form: RouteForm.Call, pattern: /\b(?:app|router|server|api|routes|fastify|hono)\.(?<method>get|post|put|patch|delete|all)\s*\(\s*["'`](?<path>[^"'`]+)/ },
  // NestJS: `@Post("users")`.
  { form: RouteForm.Decorator, pattern: /@(?<method>Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`](?<path>[^"'`]*))?/ },
]

export const TYPESCRIPT: Language = {
  name: NAME,
  spec: typescriptSpec,
  extensions: [".ts", ".mts", ".cts"],
  family: ECMASCRIPT_FAMILY,
  riskyApis: RISKY_APIS,
  errorHandlers: ERROR_HANDLERS,
  routes: ROUTES,
  librarySurface: ecmascriptSurface,
}

// Plain JavaScript goes through the TSX grammar, which accepts JS and JSX syntax.
export const TSX: Language = { ...TYPESCRIPT, spec: tsxSpec, extensions: [".tsx", ".js", ".mjs", ".cjs", ".jsx"] }
