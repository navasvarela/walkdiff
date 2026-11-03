/**
 * Whether an SPDX licence expression is allowed, such as "MIT OR Apache-2.0" or
 * "(MIT AND BSD-3-Clause) WITH LLVM-exception". OR needs one allowed side and AND needs both. An
 * exception only adds permissions, so the base licence decides.
 */
export function isLicenseAllowed(expression: string, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed.map((entry) => entry.toLowerCase()))
  return evaluate(stripOuterParentheses(expression.trim()), permitted)
}

function evaluate(expression: string, permitted: ReadonlySet<string>): boolean {
  const alternatives = splitTopLevel(expression, "OR")
  if (alternatives.length > 1) return alternatives.some((part) => evaluate(stripOuterParentheses(part), permitted))
  const required = splitTopLevel(expression, "AND")
  if (required.length > 1) return required.every((part) => evaluate(stripOuterParentheses(part), permitted))
  const base = expression.split(/\s+WITH\s+/i).at(0)?.trim() ?? ""
  return permitted.has(base.toLowerCase())
}

function splitTopLevel(expression: string, operator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const token of expression.split(/(\(|\)|\s+)/)) {
    if (token === "(") depth++
    if (token === ")") depth--
    if (depth === 0 && token.toUpperCase() === operator) {
      parts.push(current.trim())
      current = ""
    } else {
      current += token
    }
  }
  parts.push(current.trim())
  return parts.filter((part) => part !== "")
}

function stripOuterParentheses(expression: string): string {
  let text = expression
  while (text.startsWith("(") && text.endsWith(")") && closesAtEnd(text)) text = text.slice(1, -1).trim()
  return text
}

// True when the opening parenthesis is closed by the last one, not earlier, as in "(A) OR (B)".
function closesAtEnd(text: string): boolean {
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++
    if (text[index] === ")") depth--
    if (depth === 0 && index < text.length - 1) return false
  }
  return true
}

// PyPI's classifiers name licences in words. Only those with exactly one SPDX meaning are mapped,
// so "BSD License", which could be any of several, stays as written.
const PYPI_CLASSIFIER_LICENSES: Readonly<Record<string, string>> = {
  "License :: OSI Approved :: MIT License": "MIT",
  "License :: OSI Approved :: Apache Software License": "Apache-2.0",
  "License :: OSI Approved :: ISC License (ISCL)": "ISC",
  "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
  "License :: OSI Approved :: The Unlicense (Unlicense)": "Unlicense",
}

// Some projects paste their whole licence text into this field; that isn't an identifier.
const MAX_LICENSE_FIELD_CHARS = 100

/** The licence a PyPI project declares, preferring the SPDX expression newer metadata carries. */
export function pypiLicense(expression: string | null | undefined, field: string | null | undefined, classifiers: readonly string[]): string | undefined {
  if (expression) return expression
  if (field && field.length <= MAX_LICENSE_FIELD_CHARS && !field.includes("\n")) return field
  const classifier = classifiers.find((entry) => entry.startsWith("License :: "))
  return classifier === undefined ? undefined : (PYPI_CLASSIFIER_LICENSES[classifier] ?? classifier.split(" :: ").at(-1))
}
