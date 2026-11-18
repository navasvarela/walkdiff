import { AnalysisStep, codeSpan, DimensionKind, isTestPath, RiskSeverity } from "@walkdiff/review-model"
import type { CheckRun, CommitSha, Dimension, Risk } from "@walkdiff/review-model"
import { filesMentioning } from "../../impact/candidateFiles.ts"
import { creditedTo } from "../checks/credit.ts"
import type { Check, CheckContext } from "../checks/check.ts"
import { findingAt } from "../scannedFile.ts"
import type { RuleDescription } from "../scannedFile.ts"
import { staleMentions } from "./docMentions.ts"
import type { StaleMention } from "./docMentions.ts"
import { parameterDrift } from "./parameterDocs.ts"
import type { ParameterDrift } from "./parameterDocs.ts"
import { RetiredNameKind, retiredNames } from "./retiredNames.ts"
import type { RetiredName } from "./retiredNames.ts"

const DOCS_DRIFT = "docsDrift"
const DOCS_DRIFT_DIMENSION: Dimension = { id: DOCS_DRIFT, label: "Docs drift", kind: DimensionKind.Review, advice: "Update the docs to match." }
const DOCS_DRIFT_RUN: CheckRun = { name: "Docs drift", detail: "docs that still use names this PR removes or renames, and doc comments that no longer match their parameters" }
const LEADING_DASHES = /^--/

interface StaleWording {
  readonly id: string
  readonly severity: RiskSeverity
  readonly consequence: string
}

const STALE_WORDING: Readonly<Record<RetiredNameKind, StaleWording>> = {
  [RetiredNameKind.CliFlag]: { id: "docs.stale-flag", severity: RiskSeverity.Medium, consequence: "Whoever copies the command from the docs gets an error." },
  [RetiredNameKind.Setting]: { id: "docs.stale-setting", severity: RiskSeverity.Medium, consequence: "A deployment set up from the docs sets a name nothing reads, and the setting silently has no effect." },
  [RetiredNameKind.Code]: { id: "docs.stale-name", severity: RiskSeverity.Low, consequence: "Readers will look for code that isn't there." },
}

/**
 * Docs that this PR leaves out of date: prose that still uses a name it removes or renames, and
 * doc comments that describe parameters a changed function no longer takes. Reads only the
 * repository, so it runs offline.
 */
export const DOCS_DRIFT_CHECK: Check = {
  step: AnalysisStep.CheckingBreakingChanges,
  dimensions: [DOCS_DRIFT_DIMENSION],
  run: async ({ request, scanned }: CheckContext) => {
    const retired = await stillRetiredAtHead(request.repoDir, request.head, retiredNames(request.files, scanned))
    const mentions = await staleMentions(request.repoDir, request.head, retired)
    const findings = [...mentions.map(staleMentionFinding), ...parameterDrift(request.files).map(parameterFinding)]
    return { findings: creditedTo(DOCS_DRIFT_RUN.name, findings), checksRun: [DOCS_DRIFT_RUN], notChecked: [] }
  },
}

/**
 * Docs only go stale for a name nothing uses any more: code at head that still names it, anywhere,
 * means it's still there, perhaps defined in another file.
 */
async function stillRetiredAtHead(repoDir: string, head: CommitSha, retired: readonly RetiredName[]): Promise<RetiredName[]> {
  if (retired.length === 0) return []
  // An option can be declared without its dashes, as `"log-format": { … }`, so its bare name is searched.
  const searched = (name: RetiredName): string => name.name.replace(LEADING_DASHES, "")
  const inCode = await filesMentioning(repoDir, head, [...new Set(retired.map(searched))])
  // Tests that still use a retired name are out of date themselves, not proof it's still there.
  return retired.filter((name) => (inCode.get(searched(name)) ?? []).every(isTestPath))
}

function staleMentionFinding(mention: StaleMention): Risk {
  const { retired } = mention
  const wording = STALE_WORDING[retired.kind]
  const change = retired.replacement === undefined ? "removes it" : `renames it to ${codeSpan(retired.replacement)}`
  const more = mention.count > 1 ? ` This file mentions it ${mention.count} times.` : ""
  const rule: RuleDescription = {
    id: wording.id,
    category: DOCS_DRIFT,
    severity: wording.severity,
    title: `Docs still mention ${codeSpan(retired.name)}`,
    detail: `This PR ${change}.${more} ${wording.consequence}`,
  }
  return findingAt(rule, mention.path, mention.line, mention.text)
}

function parameterFinding(drift: ParameterDrift): Risk {
  const stale = drift.stale.length === 0 ? "" : `still describes ${drift.stale.map(codeSpan).join(", ")}, which it no longer takes`
  const missing = drift.missing.length === 0 ? "" : `doesn't describe ${drift.missing.map(codeSpan).join(", ")}`
  const rule: RuleDescription = {
    id: "docs.parameters",
    category: DOCS_DRIFT,
    severity: RiskSeverity.Low,
    title: `Doc comment of ${codeSpan(drift.unit)} doesn't match its parameters`,
    detail: `It ${[stale, missing].filter((part) => part !== "").join(", and ")}. Editors and generated docs show this text to everyone who calls it.`,
  }
  return findingAt(rule, drift.path, drift.line, null)
}
