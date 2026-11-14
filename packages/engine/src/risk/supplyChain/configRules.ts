import { basename } from "node:path"
import { codeSpan, isTestPath, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { addedLines, findingAt, isThirdParty } from "../scannedFile.ts"
import type { AddedLine, RuleDescription, ScannedFile } from "../scannedFile.ts"

/**
 * Settings a PR adds that change how packages are fetched or what runs when they're installed:
 * package-manager config files, requirement options, npm lifecycle scripts and Go module
 * replacements. Like the infrastructure rules, each reads one added line and skips comments.
 */

function rule(id: string, severity: RiskSeverity, title: string, detail: string): RuleDescription {
  return { id: `supply-chain.${id}`, category: RiskCategory.SupplyChain, severity, title, detail }
}

const REGISTRY_CHANGED = rule("registry-changed", RiskSeverity.Medium, "Package registry changed", "Changes where packages are downloaded from. Check the new registry is one your team runs or trusts.")
const EXTRA_INDEX = rule(
  "extra-index",
  RiskSeverity.Medium,
  "Extra package index added",
  "pip looks in every index and installs the highest version it finds, so anyone who publishes one of your private package names on PyPI wins: the dependency confusion attack. Prefer a single index that proxies PyPI.",
)
const TLS_OFF = rule("tls-off", RiskSeverity.High, "Packages download without TLS checks", "Turning off certificate checks or using plain http lets anyone on the network path swap packages as they download.")
const INSTALL_HOOK = rule(
  "install-hook",
  RiskSeverity.Medium,
  "Code that runs inside the package manager",
  "pnpm's .pnpmfile and Yarn plugins run on every install, with access to the machine and its credentials, and can rewrite what gets installed. Read it closely.",
)
const MODULE_REPLACED = rule(
  "module-replaced",
  RiskSeverity.Medium,
  "Go module replaced with another",
  "Builds use a different module than the one go.mod requires, and go.sum then trusts it. Check the replacement is a fork you mean to use.",
)

function lifecycleScript(script: string): RuleDescription {
  return rule(
    "lifecycle-script",
    RiskSeverity.Medium,
    `${codeSpan(script)} script changed`,
    "npm runs it on every install, on developers' machines and in CI, and for everyone who installs this package if it's published. Check what it runs.",
  )
}

/** One added line's problem; undefined when the line is fine. */
type LineRule = (content: string) => RuleDescription | undefined

/** A kind of package-manager file, the comment marker it uses, and its rules. */
interface ConfigFormat {
  readonly matches: (path: string) => boolean
  readonly comment: RegExp
  readonly lineRules: readonly LineRule[]
}

// Pointing at the public registry by its own address changes nothing.
const PUBLIC_REGISTRY_URL = /registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org\/simple|pypi\.python\.org|index\.crates\.io|crates\.io-index/
const PLAIN_HTTP = /["'\s=]http:\/\//
const HASH_COMMENT = /^\s*#/
const INI_COMMENT = /^\s*[#;]/

/** A rule that fires when `pattern` matches, unless the line names the public registry. */
function registryLine(pattern: RegExp): LineRule {
  return (content) => {
    if (!pattern.test(content)) return undefined
    if (PLAIN_HTTP.test(content)) return TLS_OFF
    return PUBLIC_REGISTRY_URL.test(content) ? undefined : REGISTRY_CHANGED
  }
}

function whenMatches(pattern: RegExp, found: RuleDescription): LineRule {
  return (content) => (pattern.test(content) ? found : undefined)
}

const ANY_LINE: RegExp = /\S/

const FORMATS: readonly ConfigFormat[] = [
  {
    matches: (path) => basename(path) === ".npmrc",
    comment: INI_COMMENT,
    lineRules: [whenMatches(/^\s*strict-ssl\s*=\s*false\b/i, TLS_OFF), registryLine(/^\s*(?:@[^:\s]+:)?registry\s*=/)],
  },
  {
    matches: (path) => basename(path) === ".yarnrc.yml",
    comment: HASH_COMMENT,
    lineRules: [whenMatches(/^\s*(?:enableStrictSsl:\s*false|unsafeHttpWhitelist:)/, TLS_OFF), registryLine(/^\s*npmRegistryServer:/)],
  },
  {
    matches: (path) => basename(path) === ".yarnrc",
    comment: HASH_COMMENT,
    lineRules: [whenMatches(/^\s*strict-ssl\s+false\b/, TLS_OFF), registryLine(/^\s*registry\s+/)],
  },
  { matches: (path) => basename(path) === "bunfig.toml", comment: HASH_COMMENT, lineRules: [registryLine(/^\s*registry\s*=/)] },
  {
    matches: (path) => ["pip.conf", "pip.ini"].includes(basename(path)),
    comment: INI_COMMENT,
    lineRules: [whenMatches(/^\s*trusted-host\s*=/, TLS_OFF), extraIndex(/^\s*extra-index-url\s*=/), registryLine(/^\s*index-url\s*=/)],
  },
  {
    matches: isRequirementsFile,
    comment: HASH_COMMENT,
    lineRules: [whenMatches(/^\s*--trusted-host\b/, TLS_OFF), extraIndex(/^\s*--extra-index-url\b/), registryLine(/^\s*(?:-i|--index-url)\b/)],
  },
  {
    // uv picks the first index that has a package, so an extra index isn't the risk it is for pip.
    matches: (path) => basename(path) === "uv.toml",
    comment: HASH_COMMENT,
    lineRules: [whenMatches(/^\s*allow-insecure-host\s*=/, TLS_OFF), registryLine(/^\s*(?:extra-)?index-url\s*=|^\s*url\s*=/)],
  },
  {
    matches: (path) => basename(path) === "pyproject.toml",
    comment: HASH_COMMENT,
    lineRules: [whenMatches(/^\s*allow-insecure-host\s*=/, TLS_OFF), whenMatches(/^\s*\[\[tool\.(?:uv\.index|poetry\.source)\]\]/, REGISTRY_CHANGED)],
  },
  {
    matches: (path) => /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(path),
    comment: HASH_COMMENT,
    lineRules: [registryLine(/^\s*(?:index|registry|replace-with)\s*=/)],
  },
  { matches: (path) => basename(path) === "package.json", comment: /^$/, lineRules: [npmLifecycleScript] },
  { matches: (path) => basename(path) === "go.mod", comment: /^\s*\/\//, lineRules: [goReplacement] },
]

/** Files whose every added line is code that runs during installs; one finding per file is enough. */
const INSTALL_HOOK_FILE = /(?:^|\/)(?:\.pnpmfile\.[cm]?js|\.yarn\/plugins\/.+\.[cm]?js)$/

const REQUIREMENTS_FILE = /^requirements.*\.(?:txt|in)$/
const REQUIREMENTS_FOLDER_FILE = /(?:^|\/)requirements\/[^/]+\.(?:txt|in)$/

function isRequirementsFile(path: string): boolean {
  return REQUIREMENTS_FILE.test(basename(path)) || REQUIREMENTS_FOLDER_FILE.test(path)
}

function extraIndex(pattern: RegExp): LineRule {
  return (content) => (!pattern.test(content) ? undefined : PLAIN_HTTP.test(content) ? TLS_OFF : EXTRA_INDEX)
}

// `prepare` and the rest also run on install, but mostly set up local tooling such as git hooks.
const LIFECYCLE_SCRIPT = /^\s*"(?<script>preinstall|install|postinstall)"\s*:/

function npmLifecycleScript(content: string): RuleDescription | undefined {
  const script = LIFECYCLE_SCRIPT.exec(content)?.groups?.script
  return script === undefined ? undefined : lifecycleScript(script)
}

// `replace a => b v1.2.3`, alone or inside a `replace ( … )` block. Only `replace` uses `=>`, and
// a local path (`=> ../a`) points at the project's own code.
const GO_REPLACEMENT = /=>\s*(?<target>\S+)/

function goReplacement(content: string): RuleDescription | undefined {
  const target = GO_REPLACEMENT.exec(content)?.groups?.target
  return target === undefined || /^[./]/.test(target) ? undefined : MODULE_REPLACED
}

export function packageConfigFindings(files: readonly ScannedFile[]): Risk[] {
  return files.filter((file) => !isThirdParty(file) && !isTestPath(file.diff.path)).flatMap(fileFindings)
}

function fileFindings(file: ScannedFile): Risk[] {
  const path = file.diff.path
  const added = addedLines(file.diff)
  if (INSTALL_HOOK_FILE.test(path)) return installHookFinding(path, added)
  const format = FORMATS.find((candidate) => candidate.matches(path))
  if (format === undefined) return []
  return added
    .filter((line) => !format.comment.test(line.content))
    .flatMap((line) => format.lineRules.flatMap((lineRule) => lineRule(line.content) ?? []).slice(0, 1).map((found) => findingAt(found, path, line.line, line.content)))
}

function installHookFinding(path: string, added: readonly AddedLine[]): Risk[] {
  const first = added.find((line) => ANY_LINE.test(line.content))
  return first === undefined ? [] : [findingAt(INSTALL_HOOK, path, first.line, first.content)]
}
