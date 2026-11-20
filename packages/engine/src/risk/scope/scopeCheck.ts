import { AnalysisStep, codeSpan, DimensionKind, FileChangeStatus, RiskSeverity } from "@walkdiff/review-model"
import type { ChangedFile, CheckRun, CommitSha, Dimension, Risk } from "@walkdiff/review-model"
import { readBlobs } from "../../blobs.ts"
import type { Check } from "../checks/check.ts"
import { creditedTo } from "../checks/credit.ts"
import type { RuleDescription } from "../scannedFile.ts"
import { lockfileReaderFor } from "../supplyChain/lockfileReaders.ts"
import { areasOf, connectedGroups, workspacePackages } from "./areas.ts"
import type { Area } from "./areas.ts"
import { Concern, concernOf } from "./concerns.ts"

/**
 * PRs that mix concerns: a tidy-up or a bulk dependency upgrade riding along with behaviour
 * changes, or behaviour changes in packages that have nothing to do with each other. Each half
 * would be easier to review, and to revert, on its own.
 *
 * The limits are judgement calls: a few formatted files or upgraded packages come with ordinary
 * work, so it takes enough of them to bury the change that matters.
 */
const MIN_TIDY_FILES = 5
const MIN_UPGRADED_PACKAGES = 10
// An area needs this many changed units of behaviour to count as work of its own, not a one-line follow-on.
const MIN_UNITS_PER_AREA = 3
const FILES_NAMED = 3

const SCOPE = "scope"
const SCOPE_DIMENSION: Dimension = { id: SCOPE, label: "Scope", kind: DimensionKind.Review, advice: "Ask whether it should be split." }
const SCOPE_RUN: CheckRun = { name: "Scope", detail: "tidy-ups, bulk dependency upgrades and unrelated packages mixed in with behaviour changes" }

export const SCOPE_CHECK: Check = {
  step: AnalysisStep.ScanningCode,
  dimensions: [SCOPE_DIMENSION],
  run: async ({ request }) => {
    const byConcern = groupByConcern(request.files)
    const behaviour = byConcern.get(Concern.Behaviour) ?? []
    if (behaviour.length === 0) return { findings: [], checksRun: [SCOPE_RUN], notChecked: [] }
    const tidy = byConcern.get(Concern.TidyUp) ?? []
    const upgrades = await upgradedPackages(request.repoDir, request.base, request.head, byConcern.get(Concern.Dependencies) ?? [])
    const packages = await workspacePackages(request.repoDir, request.head)
    const groups = connectedGroups(areasOf(behaviour, packages), packages).filter((group) => unitsIn(group) >= MIN_UNITS_PER_AREA)
    const findings = [...mixedConcernsFinding(behaviour, tidy, upgrades), ...unrelatedAreasFinding(groups)]
    return { findings: creditedTo(SCOPE_RUN.name, findings), checksRun: [SCOPE_RUN], notChecked: [] }
  },
}

function groupByConcern(files: readonly ChangedFile[]): Map<Concern, ChangedFile[]> {
  const groups = new Map<Concern, ChangedFile[]>()
  for (const file of files) {
    const concern = concernOf(file)
    const group = groups.get(concern)
    if (group === undefined) groups.set(concern, [file])
    else group.push(file)
  }
  return groups
}

interface Upgrades {
  readonly packages: number
  readonly lockfiles: readonly string[]
}

/**
 * Packages a lockfile already had that the PR moves to other versions. A package new to the
 * lockfile comes with the code that uses it, so it doesn't count; neither does a lockfile that
 * can't be read, which the supply-chain check reports.
 */
async function upgradedPackages(repoDir: string, base: CommitSha, head: CommitSha, lockfiles: readonly ChangedFile[]): Promise<Upgrades> {
  const readable = lockfiles.filter((file) => file.diff.status === FileChangeStatus.Modified && lockfileReaderFor(file.diff.path) !== undefined)
  const blobs = await readBlobs(repoDir, readable.flatMap((file) => [{ commit: base, path: file.diff.path }, { commit: head, path: file.diff.path }]))
  const counted = readable.map((file, index) => {
    const reader = lockfileReaderFor(file.diff.path)
    const before = blobs.at(2 * index)?.toString("utf8")
    const after = blobs.at(2 * index + 1)?.toString("utf8")
    if (reader === undefined || before === undefined || after === undefined) return 0
    try {
      return countUpgrades(versionsByName(reader.read(before)), versionsByName(reader.read(after)))
    } catch {
      // An unreadable lockfile is the supply-chain check's to report; here it upgrades nothing.
      return 0
    }
  })
  return { packages: counted.reduce((sum, count) => sum + count, 0), lockfiles: readable.filter((_, index) => (counted[index] ?? 0) > 0).map((file) => file.diff.path) }
}

function versionsByName(packages: readonly { readonly name: string; readonly version: string }[]): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>()
  for (const { name, version } of packages) {
    const known = versions.get(name)
    if (known === undefined) versions.set(name, new Set([version]))
    else known.add(version)
  }
  return versions
}

function countUpgrades(before: ReadonlyMap<string, ReadonlySet<string>>, after: ReadonlyMap<string, ReadonlySet<string>>): number {
  return [...after].filter(([name, versions]) => {
    const earlier = before.get(name)
    return earlier !== undefined && [...versions].some((version) => !earlier.has(version))
  }).length
}

function unitsIn(group: readonly Area[]): number {
  return group.reduce((sum, area) => sum + area.units, 0)
}

function mixedConcernsFinding(behaviour: readonly ChangedFile[], tidy: readonly ChangedFile[], upgrades: Upgrades): Risk[] {
  const parts = [
    ...(tidy.length >= MIN_TIDY_FILES ? [`${tidy.length} files that are only reformatted, re-commented, renamed or moved (${named(tidy)})`] : []),
    ...(upgrades.packages >= MIN_UPGRADED_PACKAGES ? [`${upgrades.packages} package upgrades in ${upgrades.lockfiles.map(codeSpan).join(" and ")}`] : []),
  ]
  if (parts.length === 0) return []
  const rule: RuleDescription = {
    id: "scope.mixed-concerns",
    category: SCOPE,
    severity: RiskSeverity.Low,
    title: tidy.length >= MIN_TIDY_FILES && upgrades.packages >= MIN_UPGRADED_PACKAGES ? "Mixes a tidy-up and upgrades with behaviour changes" : tidy.length >= MIN_TIDY_FILES ? "Mixes a tidy-up with behaviour changes" : "Mixes dependency upgrades with behaviour changes",
    detail: `Besides behaviour changes in ${behaviour.length} ${behaviour.length === 1 ? "file" : "files"}, it has ${parts.join(", and ")}. Reviewers have to find the change that matters among the rest. Landing them separately makes each easier to review, and to revert.`,
  }
  return [{ ruleId: rule.id, category: rule.category, severity: rule.severity, title: rule.title, detail: rule.detail, location: null, evidence: null }]
}

function unrelatedAreasFinding(groups: readonly (readonly Area[])[]): Risk[] {
  if (groups.length < 2) return []
  const described = groups.map((group) => group.map((area) => (area.root === "" ? "the repository root" : codeSpan(area.root))).join(" with ")).join("; ")
  return [
    {
      ruleId: "scope.unrelated-areas",
      category: SCOPE,
      severity: RiskSeverity.Low,
      title: `Changes ${groups.length} packages that don't use each other`,
      detail: `Behaviour changes in ${described}, with nothing in this PR tying them together. Each could be reviewed, released and reverted on its own.`,
      location: null,
      evidence: null,
    },
  ]
}

function named(files: readonly ChangedFile[]): string {
  const shown = files.slice(0, FILES_NAMED).map((file) => codeSpan(file.diff.path))
  const rest = files.length - shown.length
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ")
}
