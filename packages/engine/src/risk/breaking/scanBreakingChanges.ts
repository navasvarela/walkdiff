import type { ChangedFile, CommitSha, Risk, SkippedCheck } from "@walkdiff/review-model"
import type { FileVersions } from "../../syntax/compareUnits.ts"
import type { ScannedFile } from "../scannedFile.ts"
import { scanApiSchemas } from "./apiSchemas/scanApiSchemas.ts"
import { mentionsInCode } from "./codeMentions.ts"
import { ConfigChangeKind, configChangeFinding, findConfigChanges } from "./configuration.ts"
import { readLibrarySurface } from "./readLibrarySurface.ts"
import { findSchemaChanges, schemaChangeFinding } from "./migrations.ts"
import { scanPublicApi } from "./publicApi.ts"

export interface BreakingChangeScan {
  readonly repoDir: string
  readonly base: CommitSha
  readonly head: CommitSha
  /** The change's files, without those excluded by the repository's config. */
  readonly files: readonly ChangedFile[]
  readonly scanned: readonly ScannedFile[]
  readonly versions: readonly FileVersions[]
}

export interface BreakingChangeFindings {
  readonly findings: Risk[]
  /** Files a check couldn't read, such as an API schema that doesn't parse. */
  readonly notChecked: SkippedCheck[]
}

/** Flags changes that could break other code or a deployment, saying what breaks and who is affected. */
export async function scanBreakingChanges(scan: BreakingChangeScan): Promise<BreakingChangeFindings> {
  const surface = await readLibrarySurface(scan.repoDir, scan.base, scan.files.map((file) => ("previousPath" in file.diff ? file.diff.previousPath : file.diff.path)))
  const headTexts = new Map(scan.scanned.flatMap((file) => (file.after === undefined ? [] : [[file.diff.path, file.after] as const])))
  const schemaChanges = findSchemaChanges(scan.scanned)
  const configChanges = findConfigChanges(scan.scanned)
  const names = [...new Set([...schemaChanges, ...configChanges].map((change) => change.name))]
  const mentions = await mentionsInCode(scan.repoDir, scan.head, names)

  // An env file and the code can both show one rename; a finding on either tells the whole story.
  const renamesInEnvFiles = new Set(configChanges.filter((change) => change.kind === ConfigChangeKind.RenamedVariable).map((change) => change.name))
  const config = configChanges
    .filter((change) => change.kind !== ConfigChangeKind.ReplacedRead || !renamesInEnvFiles.has(change.name))
    .flatMap((change) => configChangeFinding(change, mentions.get(change.name)) ?? [])

  const apiSchemas = await scanApiSchemas(scan.repoDir, scan.base, scan.scanned)
  return {
    findings: [
      ...scanPublicApi({ files: scan.files, versions: scan.versions, headTexts, surface }),
      ...apiSchemas.findings,
      ...schemaChanges.map((change) => schemaChangeFinding(change, mentions.get(change.name))),
      ...config,
    ],
    notChecked: apiSchemas.notChecked,
  }
}
