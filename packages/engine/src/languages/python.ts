import { RiskSeverity } from "@walkdiff/review-model"
import type { Node } from "web-tree-sitter"
import { apiRule, CODE_EXECUTION, SQL_INTERPOLATION, TLS_DISABLED } from "../risk/apiRules.ts"
import { pythonSurface } from "../risk/breaking/librarySurface.ts"
import { CATCH_ALL, isEmptyBlock, lastChildOfType, SWALLOWED } from "../risk/errorHandlers.ts"
import { RouteForm } from "../risk/routeSyntax.ts"
import type { RuleDescription } from "../risk/scannedFile.ts"
import { pythonSpec } from "../syntax/python.ts"
import type { Language } from "./language.ts"

const CATCH_ALL_TYPE = "BaseException"

// `except:` and `except BaseException:` catch everything, including KeyboardInterrupt.
function exceptClause(node: Node): RuleDescription | undefined {
  const block = lastChildOfType(node, "block")
  if (isEmptyBlock(block)) return SWALLOWED
  const caught = node.namedChildren.filter((child): child is Node => child !== null && child.type !== "block" && !child.type.includes("comment"))
  const isBare = caught.length === 0
  return isBare || caught.some((child) => child.text === CATCH_ALL_TYPE) ? CATCH_ALL : undefined
}

export const PYTHON: Language = {
  name: "Python",
  spec: pythonSpec,
  extensions: [".py", ".pyi"],
  riskyApis: [
    apiRule("python.eval", RiskSeverity.High, /(?<![.\w])(?:eval|exec)\s*\(/, "eval() / exec()", CODE_EXECUTION),
    apiRule("python.subprocess-shell", RiskSeverity.High, /\bshell\s*=\s*True\b/, "Subprocess with shell=True", "The command goes through a shell, so user input in it can run arbitrary commands."),
    apiRule("python.os-system", RiskSeverity.High, /\bos\.(?:system|popen)\s*\(/, "os.system() / os.popen()", "Runs a shell command; user input in it can run arbitrary commands."),
    apiRule("python.pickle", RiskSeverity.Medium, /\b(?:pickle|cPickle|dill)\.loads?\s*\(/, "Unpickling", "Loading a pickle runs code embedded in it; never unpickle data from untrusted sources."),
    {
      ...apiRule("python.yaml-load", RiskSeverity.Medium, /\byaml\.(?:load|load_all)\s*\(/, "yaml.load() without a safe loader", "PyYAML's full loader can construct arbitrary objects; use yaml.safe_load."),
      safeWhen: /SafeLoader|CSafeLoader/,
    },
    apiRule("python.tls-disabled", RiskSeverity.High, /\bverify\s*=\s*False\b/, "TLS verification disabled", TLS_DISABLED),
    apiRule("python.sql-format", RiskSeverity.Medium, /\.execute(?:many)?\s*\(\s*(?:f["']|["'][^"']*["']\s*(?:%|\.format\())/, "SQL from string formatting", SQL_INTERPOLATION),
  ],
  errorHandlers: [{ types: ["except_clause"], check: exceptClause }],
  routes: [
    // FastAPI and Flask: `@app.get("/users")`, `@router.post(…)`, `@bp.route(…)`.
    { form: RouteForm.Decorator, pattern: /@\w+\.(?<method>get|post|put|patch|delete|route|api_route)\(\s*["'](?<path>[^"']+)/ },
    // Django: `path("users/", views.users)`.
    { form: RouteForm.Call, pattern: /\b(?:re_)?path\(\s*r?["'](?<path>[^"']*)["']\s*,/ },
  ],
  librarySurface: pythonSurface,
}
