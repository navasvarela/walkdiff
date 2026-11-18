import { FileChangeStatus, isTestPath } from "@walkdiff/review-model"
import type { CommitSha, FileDiff, Risk, SkippedCheck } from "@walkdiff/review-model"
import { readBlobs } from "../../../blobs.ts"
import { isThirdParty } from "../../scannedFile.ts"
import type { ScannedFile } from "../../scannedFile.ts"
import { apiChangeFinding } from "./apiChange.ts"
import type { ApiSchemaFormat, SchemaFile } from "./apiChange.ts"
import { GRAPHQL } from "./graphql.ts"
import { OPEN_API } from "./openApi.ts"
import { PROTOBUF } from "./protobuf.ts"

const FORMATS: readonly ApiSchemaFormat[] = [OPEN_API, GRAPHQL, PROTOBUF]

export interface ApiSchemaScan {
  readonly findings: Risk[]
  /** Schema formats whose files couldn't be read, with which file and why. */
  readonly notChecked: SkippedCheck[]
}

/** One format's files: as they were, for those the PR changes or deletes, and every one it leaves. */
interface FormatFiles {
  readonly before: SchemaFile[]
  readonly after: SchemaFile[]
}

/**
 * Compares the API schemas a PR touches with their versions at the merge base. A format is only
 * compared when the PR changes or deletes one of its files: a new schema file can't break anyone.
 */
export async function scanApiSchemas(repoDir: string, base: CommitSha, files: readonly ScannedFile[]): Promise<ApiSchemaScan> {
  const scan: ApiSchemaScan = { findings: [], notChecked: [] }
  for (const [format, { before, after }] of await filesByFormat(repoDir, base, files)) {
    if (before.length === 0) continue
    try {
      scan.findings.push(...format.compare(before, after).map((change) => apiChangeFinding(format, change)))
    } catch (error: unknown) {
      scan.notChecked.push({ check: `${format.name} breaking changes`, reason: `couldn't read ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return scan
}

async function filesByFormat(repoDir: string, base: CommitSha, files: readonly ScannedFile[]): Promise<Map<ApiSchemaFormat, FormatFiles>> {
  const relevant = files.filter((file) => !isThirdParty(file) && !isTestPath(file.diff.path))
  const earlier = relevant.filter((file) => file.diff.status !== FileChangeStatus.Added)
  const blobs = await readBlobs(repoDir, earlier.map((file) => ({ commit: base, path: previousPathOf(file.diff) })))
  const before = new Map(earlier.flatMap((file, index) => {
    const text = blobs.at(index)?.toString("utf8")
    return text === undefined ? [] : [[file, text] as const]
  }))
  const byFormat = new Map<ApiSchemaFormat, FormatFiles>()
  for (const file of relevant) {
    const earlierText = before.get(file)
    const after = file.diff.status === FileChangeStatus.Deleted ? "" : file.after
    const format = FORMATS.find((candidate) => candidate.matches(file.diff.path, after === undefined || after === "" ? (earlierText ?? "") : after))
    if (format === undefined || after === undefined) continue
    const entry = byFormat.get(format) ?? { before: [], after: [] }
    // A renamed file is compared under its new name, so its changes point at where it is now.
    if (earlierText !== undefined) entry.before.push({ path: file.diff.path, text: earlierText })
    entry.after.push({ path: file.diff.path, text: after })
    byFormat.set(format, entry)
  }
  return byFormat
}

function previousPathOf(diff: FileDiff): string {
  return diff.status === FileChangeStatus.Renamed || diff.status === FileChangeStatus.Copied ? diff.previousPath : diff.path
}
