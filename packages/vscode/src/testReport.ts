import { REVIEW_MODEL_SCHEMA_VERSION, reviewModelSchema } from "@walkdiff/review-model"
import type { ReviewModel } from "@walkdiff/review-model"

const SHA = "a".repeat(40)

/**
 * A report for tests: `src/retry.ts` with old lines 1–3 and new lines 1–3, old line 2 replaced by
 * new line 2, then new line 20 added after a gap; and `src/limits.ts`, renamed from
 * `src/caps.ts`, with new line 5 added.
 */
export function testReport(): ReviewModel {
  return reviewModelSchema.parse({
    schemaVersion: REVIEW_MODEL_SCHEMA_VERSION,
    generatedAt: "2026-11-22T00:00:00.000Z",
    pullRequest: { host: "github", url: "https://github.com/acme/app/pull/7", repositoryWebUrl: "https://github.com/acme/app", number: 7, title: "t", description: "", author: "dev", baseRef: "main", headRef: "x", baseSha: SHA, headSha: SHA, mergeBaseSha: SHA },
    files: [
      {
        diff: {
          status: "modified",
          path: "src/retry.ts",
          additions: 2,
          deletions: 1,
          content: {
            kind: "text",
            hunks: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                section: "",
                lines: [
                  { kind: "context", content: "a", oldLine: 1, newLine: 1 },
                  { kind: "removed", content: "b", oldLine: 2 },
                  { kind: "added", content: "B", newLine: 2 },
                  { kind: "context", content: "c", oldLine: 3, newLine: 3 },
                ],
              },
              { oldStart: 19, oldLines: 0, newStart: 20, newLines: 1, section: "", lines: [{ kind: "added", content: "z", newLine: 20 }] },
            ],
          },
        },
        noise: null,
        syntax: { status: "unsupportedLanguage" },
      },
      {
        diff: {
          status: "renamed",
          path: "src/limits.ts",
          previousPath: "src/caps.ts",
          similarity: 90,
          additions: 1,
          deletions: 0,
          content: { kind: "text", hunks: [{ oldStart: 4, oldLines: 0, newStart: 5, newLines: 1, section: "", lines: [{ kind: "added", content: "x", newLine: 5 }] }] },
        },
        noise: null,
        syntax: { status: "unsupportedLanguage" },
      },
    ],
    risk: { securityLevel: "low", findings: [], checksRun: [], notChecked: [] },
    ai: { status: "disabled" },
    feedbackUrl: null,
  })
}
