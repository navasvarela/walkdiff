import { basename } from "node:path"
import { NoiseKind } from "@walkdiff/review-model"
import type { FileNoise } from "@walkdiff/review-model"

const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "Cargo.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "pdm.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
])

// pip-tools and uv write locked requirements with a hash per package; nobody writes those by hand.
const REQUIREMENTS_FILE = /requirements[^/]*\.txt$/
const LOCKED_REQUIREMENT_HASH = /^\s+--hash=sha256:[0-9a-f]{64}/m

const VENDORED_DIRECTORIES: ReadonlySet<string> = new Set(["vendor", "third_party", "third-party", "node_modules"])

interface PathRule {
  readonly pattern: RegExp
  readonly reason: string
}

const GENERATED_PATH_RULES: readonly PathRule[] = [
  { pattern: /\.min\.(js|css)$/, reason: "minified file" },
  { pattern: /_pb2(_grpc)?\.pyi?$/, reason: "protobuf-generated Python" },
  { pattern: /\.pb\.(go|cc|h)$/, reason: "protobuf-generated code" },
  { pattern: /\.generated\.\w+$/, reason: "\".generated.\" in the file name" },
  { pattern: /(^|\/)__generated__\//, reason: "inside a __generated__ directory" },
]

// Conventions code generators use to mark their output. `@generated` is Meta's and
// GitHub's linguist marker; "Code generated ... DO NOT EDIT." is Go's standard.
const GENERATED_HEADER_MARKERS: readonly RegExp[] = [
  /@generated\b/,
  /\bDO NOT EDIT\b/,
  /\bauto-?generated\b/i,
  /\bautomatically generated\b/i,
]
// Markers belong in a file's header; looking further would flag files that merely
// mention them, such as the code generator itself.
const GENERATED_HEADER_LINES = 5

/**
 * Decides whether a reviewer can skip a file, judging from its path and the first lines
 * of its content. Returns null for files that need review.
 */
export function classifyNoise(path: string, content: string | undefined): FileNoise | null {
  const name = basename(path)
  if (LOCKFILE_NAMES.has(name)) {
    return { kind: NoiseKind.Lockfile, reason: `${name} is a dependency lockfile` }
  }
  if (REQUIREMENTS_FILE.test(name) && content !== undefined && LOCKED_REQUIREMENT_HASH.test(content)) {
    return { kind: NoiseKind.Lockfile, reason: `${name} is locked with a hash for every package` }
  }
  const vendoredDirectory = path.split("/").slice(0, -1).find((segment) => VENDORED_DIRECTORIES.has(segment))
  if (vendoredDirectory !== undefined) {
    return { kind: NoiseKind.Vendored, reason: `inside a ${vendoredDirectory} directory` }
  }
  const pathRule = GENERATED_PATH_RULES.find((rule) => rule.pattern.test(path))
  if (pathRule !== undefined) {
    return { kind: NoiseKind.Generated, reason: pathRule.reason }
  }
  const marker = generatedMarker(content)
  return marker === undefined ? null : { kind: NoiseKind.Generated, reason: `header says "${marker}"` }
}

function generatedMarker(content: string | undefined): string | undefined {
  const header = content?.split("\n", GENERATED_HEADER_LINES).join("\n") ?? ""
  for (const pattern of GENERATED_HEADER_MARKERS) {
    const match = pattern.exec(header)
    if (match !== null) return match[0]
  }
  return undefined
}

/** Lockfiles and vendored files are classified by path alone, so their content need not be read. */
export function isNoiseByPath(path: string): boolean {
  return classifyNoise(path, undefined) !== null
}
