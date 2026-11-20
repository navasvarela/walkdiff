import { extname } from "node:path"
import { changedUnitsOf, FileChangeStatus, isBehaviourChange, isTestPath, NoiseKind, SyntaxAnalysisStatus } from "@walkdiff/review-model"
import type { ChangedFile } from "@walkdiff/review-model"

/** What kind of work a changed file carries, as far as mixing concerns goes. */
export const Concern = {
  /** Code whose behaviour changes: units added, removed, or edited beyond formatting and comments. */
  Behaviour: "behaviour",
  /** Code that's only reformatted, re-commented, renamed or moved. */
  TidyUp: "tidyUp",
  /** A lockfile; how many packages it upgrades decides whether it's a concern of its own. */
  Dependencies: "dependencies",
  /** Tests, docs, CI and config, which normally travel with the change they belong to. */
  Neutral: "neutral",
  /** Generated or vendored files, which say nothing about what the author meant to change. */
  Ignored: "ignored",
} as const
export type Concern = (typeof Concern)[keyof typeof Concern]

// Code the engine doesn't parse, whose changes are taken as behaviour since nothing says otherwise.
const UNPARSED_CODE: ReadonlySet<string> = new Set([".rb", ".php", ".swift", ".scala", ".sh", ".sql", ".lua", ".ex", ".exs", ".erl", ".clj", ".dart", ".r", ".pl"])
const IDENTICAL_MOVE = 100

export function concernOf(file: ChangedFile): Concern {
  const { diff, noise, syntax } = file
  if (noise?.kind === NoiseKind.Lockfile) return Concern.Dependencies
  if (noise !== null) return Concern.Ignored
  if (isTestPath(diff.path)) return Concern.Neutral
  if ((diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied) && diff.similarity === IDENTICAL_MOVE) return Concern.TidyUp
  if (syntax.status !== SyntaxAnalysisStatus.Analyzed) return UNPARSED_CODE.has(extname(diff.path).toLowerCase()) ? Concern.Behaviour : Concern.Neutral
  const units = changedUnitsOf(file)
  if (units.some((unit) => isBehaviourChange(unit.change))) return Concern.Behaviour
  return units.length > 0 ? Concern.TidyUp : Concern.Neutral
}
