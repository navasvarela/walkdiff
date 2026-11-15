import { RiskSeverity } from "@walkdiff/review-model"
import { apiRule, SPAWNS_PROCESSES, TLS_DISABLED, UNCHECKED_CAST } from "../risk/apiRules.ts"
import type { ApiRule } from "../risk/apiRules.ts"
import { catchWith } from "../risk/errorHandlers.ts"
import { cppSpec, cSpec } from "../syntax/cFamily.ts"
import type { Language } from "./language.ts"

// C and C++ share headers, so code in one can refer to units defined in the other.
const C_FAMILY = "c"
const CATCH_ALL_CPP = "(...)"

const C_RISKY_APIS: readonly ApiRule[] = [
  apiRule("c.unbounded-copy", RiskSeverity.Medium, /\b(?:strcpy|strcat|stpcpy|wcscpy|wcscat|sprintf|vsprintf|gets)\s*\(/, "Unbounded string copy", "Writes with no length limit, so input longer than the buffer overflows it. Use a bounded form such as snprintf."),
  apiRule(
    "c.format-string",
    RiskSeverity.Medium,
    /\b(?:printf\s*\(|fprintf\s*\(\s*[\w.>-]+\s*,)\s*[A-Za-z_][\w.>-]*\s*\)/,
    "Format string from a variable",
    "If the text can come from users, conversions such as %n and %s in it read or write memory. Print it through \"%s\" instead.",
  ),
  apiRule("c.exec", RiskSeverity.Medium, /\b(?:system|popen|exec(?:l|lp|le|v|vp|vpe|ve))\s*\(/, "Spawns processes", SPAWNS_PROCESSES),
  apiRule("c.tls-disabled", RiskSeverity.High, /\bSSL_(?:CTX_)?set_verify\s*\([^,]+,\s*SSL_VERIFY_NONE\b|\bCURLOPT_SSL_VERIFY(?:PEER|HOST)\s*,\s*0/, "TLS verification disabled", TLS_DISABLED),
]

export const C: Language = {
  name: "C",
  spec: cSpec,
  extensions: [".c"],
  family: C_FAMILY,
  riskyApis: C_RISKY_APIS,
  errorHandlers: [],
  routes: [],
}

export const CPP: Language = {
  name: "C++",
  spec: cppSpec,
  // A `.h` header may be C or C++. The C++ grammar reads both, short of C code using a C++
  // keyword such as `new` as a name; the C grammar would drop every class in a C++ header.
  extensions: [".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".inl", ".ipp", ".tpp"],
  family: C_FAMILY,
  riskyApis: [...C_RISKY_APIS, apiRule("cpp.reinterpret-cast", RiskSeverity.Medium, /\breinterpret_cast\s*</, "reinterpret_cast", UNCHECKED_CAST)],
  errorHandlers: [{ types: ["catch_clause"], check: (node) => catchWith(node.childForFieldName("body"), node.childForFieldName("parameters")?.text, CATCH_ALL_CPP) }],
  routes: [],
}
