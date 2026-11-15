import { RiskSeverity } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { apiRule, SPAWNS_PROCESSES, SQL_INTERPOLATION, TLS_DISABLED } from "../risk/apiRules.ts"
import { goSurface } from "../risk/breaking/librarySurface.ts"
import { isEmptyBlock, RESULT_DISCARDED, SWALLOWED } from "../risk/errorHandlers.ts"
import { RouteForm } from "../risk/routeSyntax.ts"
import type { RuleDescription } from "../risk/scannedFile.ts"
import { goSpec } from "../syntax/go.ts"
import type { Language } from "./language.ts"

const ERROR_CHECK = /^\s*err\s*!=\s*nil\s*$/
const DISCARD = "_"

// `if err != nil { }` with nothing in it and no else.
function emptyErrorCheck(node: Node): RuleDescription | undefined {
  const condition = node.childForFieldName("condition")?.text ?? ""
  const hasElse = node.childForFieldName("alternative") !== null
  return ERROR_CHECK.test(condition) && !hasElse && isEmptyBlock(node.childForFieldName("consequence")) ? SWALLOWED : undefined
}

// `_ = f.Close()`: only a call's result, as `_ = x` is how Go silences an unused variable.
function discardedCall(node: Node): RuleDescription | undefined {
  const left = node.childForFieldName("left")
  const right = node.childForFieldName("right")
  return left?.text === DISCARD && right?.namedChildren.length === 1 && right.firstNamedChild?.type === "call_expression" ? RESULT_DISCARDED : undefined
}

export const GO: Language = {
  name: "Go",
  spec: goSpec,
  extensions: [".go"],
  riskyApis: [
    apiRule("go.unsafe", RiskSeverity.Medium, /\bunsafe\.(?:Pointer|Slice|String|StringData|SliceData|Add)\b/, "unsafe pointer use", "Go no longer checks types or bounds here; review the memory layout the code relies on."),
    apiRule("go.exec", RiskSeverity.Medium, /\bexec\.Command(?:Context)?\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
    apiRule("go.tls-disabled", RiskSeverity.High, /\bInsecureSkipVerify\s*:\s*true\b/, "TLS verification disabled", TLS_DISABLED),
    apiRule("go.unescaped-template", RiskSeverity.Medium, /\btemplate\.(?:HTML|HTMLAttr|JS|JSStr|CSS|URL)\s*\(/, "Marks text as safe for a template", "html/template won't escape it; if any of it comes from users, that's cross-site scripting."),
    apiRule("go.sql-format", RiskSeverity.Medium, /\.(?:Query|QueryRow|Exec)(?:Context)?\s*\([^)]*\bfmt\.Sprintf\s*\(/, "SQL from fmt.Sprintf", SQL_INTERPOLATION),
  ],
  errorHandlers: [
    { types: ["if_statement"], check: emptyErrorCheck },
    { types: ["assignment_statement"], check: discardedCall },
  ],
  routes: [
    // net/http, including Go 1.22's "POST /users" patterns; gin, echo and chi: `r.POST("/users", …)`.
    { form: RouteForm.Call, pattern: /\.(?:HandleFunc|Handle)\s*\(\s*"(?<path>[^"]+)"/ },
    { form: RouteForm.Call, pattern: /\.(?<method>GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\s*\(\s*"(?<path>\/[^"]*)"/ },
  ],
  librarySurface: goSurface,
}
