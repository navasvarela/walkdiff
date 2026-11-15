import { RiskCategory } from "@walkdiff/review-model"
import type { RiskSeverity } from "@walkdiff/review-model"
import type { RuleDescription } from "./scannedFile.ts"

/** A risky API a language's code can call, matched on one added line. Each language lists its own. */
export interface ApiRule extends RuleDescription {
  readonly pattern: RegExp
  /** Text on the same line that makes the use safe, such as an explicit safe loader. */
  readonly safeWhen?: RegExp
}

export function apiRule(id: string, severity: RiskSeverity, pattern: RegExp, title: string, detail: string): ApiRule {
  return { id, severity, pattern, title, detail, category: RiskCategory.DangerousApi }
}

// What several languages' rules say about the same kind of risk.
export const CODE_EXECUTION = "Runs a string as code. If any part of it can come from users or files, it is a code-injection hole."
export const TLS_DISABLED = "Turns off certificate checks, so anyone on the network path can read or alter the traffic."
export const SQL_INTERPOLATION = "SQL assembled from interpolated values is open to injection. Use bound parameters instead."
export const SPAWNS_PROCESSES = "Check that no user input reaches the command or its arguments unchecked."
export const DESERIALIZATION = "Reading objects from a stream can run code chosen by whoever wrote it; never deserialize untrusted data."
export const UNCHECKED_CAST = "Reinterprets memory with no checks; a wrong type or size is undefined behaviour."
