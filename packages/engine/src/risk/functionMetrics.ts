import { isTestPath, isTestUnit, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import type { FunctionQuality } from "../syntax/functionQuality.ts"
import type { FunctionMetrics } from "../syntax/shape.ts"
import { findingAt } from "./scannedFile.ts"
import type { RuleDescription } from "./scannedFile.ts"

interface MetricRule extends RuleDescription {
  readonly metric: keyof FunctionMetrics
  readonly limit: number
  readonly label: string
}

function metricRule(metric: keyof FunctionMetrics, limit: number, severity: RiskSeverity, title: string, label: string, detail: string): MetricRule {
  return { id: `quality.${metric}`, category: RiskCategory.CodeQuality, severity, metric, limit, title, label, detail }
}

// McCabe proposed 10 and ESLint defaults to 20; 15 sits between them, since a report that flags
// ordinary functions stops being read. Lower it and more routine dispatch code gets flagged.
const MAX_COMPLEXITY = 15
// ESLint's `max-depth` default.
const MAX_NESTING = 4
// A judgement call: about two screens, after which a reader can no longer see the whole function.
const MAX_LINES = 80
// Ruff's PLR0913 allows 5 and Clippy's `too_many_arguments` allows 7.
const MAX_PARAMETERS = 6
// A function already over a limit only counts once it grows this much, so that one line added to
// a long function does not earn a finding. Chosen by judgement, not measured.
const MEANINGFUL_GROWTH = 1.2

const METRIC_RULES: readonly MetricRule[] = [
  metricRule("complexity", MAX_COMPLEXITY, RiskSeverity.Medium, "Complex function", "complexity", `More than ${MAX_COMPLEXITY} paths through a function make it hard to test and to reason about. Consider splitting it.`),
  metricRule("nesting", MAX_NESTING, RiskSeverity.Medium, "Deeply nested function", "nesting depth", `Control flow nested more than ${MAX_NESTING} levels deep is hard to follow. Early returns or extracted functions usually flatten it.`),
  metricRule("lines", MAX_LINES, RiskSeverity.Low, "Long function", "lines", `A function over ${MAX_LINES} lines usually does more than one thing.`),
  metricRule("parameters", MAX_PARAMETERS, RiskSeverity.Low, "Many parameters", "parameters", `More than ${MAX_PARAMETERS} parameters are easy to pass in the wrong order. Consider grouping them into a type.`),
]

/** Flags functions this PR added over a limit or made meaningfully worse; test code is left out. */
export function scanFunctionMetrics(functions: readonly FunctionQuality[]): Risk[] {
  return functions
    .filter((fn) => !isTestPath(fn.path) && !isTestUnit(fn))
    .flatMap((fn) =>
      METRIC_RULES.flatMap((rule) => {
        const before = fn.before?.[rule.metric]
        const after = fn.after[rule.metric]
        if (!isWorseThanLimit(before, after, rule.limit)) return []
        const change = before === undefined ? `${after} (new)` : `${before} → ${after}`
        return [findingAt(rule, fn.path, fn.line, `${fn.qualifiedName}: ${rule.label} ${change}`)]
      }),
    )
}

function isWorseThanLimit(before: number | undefined, after: number, limit: number): boolean {
  if (after <= limit) return false
  return before === undefined || before <= limit || after >= before * MEANINGFUL_GROWTH
}
