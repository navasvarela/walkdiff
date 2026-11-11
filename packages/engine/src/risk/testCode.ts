const TEST_PATHS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|specs)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|rs|go|c|cc|cpp|cxx)$/,
  /(^|\/)tests?\.rs$/,
]
// Rust keeps tests inline in `mod tests`; Python and JS name them test_* or put them in Test classes.
const TEST_UNIT = /(^|::|\.)tests?(::|\.)|(^|::|\.)test_|^Test/

export function isTestPath(path: string): boolean {
  return TEST_PATHS.some((pattern) => pattern.test(path))
}

export function isTestUnit(qualifiedName: string): boolean {
  return TEST_UNIT.test(qualifiedName)
}
