import { describe, expect, it } from "vitest"
import { commitShaSchema } from "@walkdiff/review-model"
import type { ProgressRecord, ReportHead } from "@walkdiff/review-model"
import { progressLabel, progressOf } from "./progress.ts"

const REPORT: ReportHead = { headSha: commitShaSchema.parse("a".repeat(40)), baseRef: "main" }
const record = (reviewed: number, total: number, drafts = 0, head: ReportHead = REPORT): ProgressRecord => ({ reviewed, total, drafts, head })

describe("a review's progress", () => {
  it.each([
    ["never opened here", undefined, REPORT, "not started"],
    ["opened but not started", record(0, 5), REPORT, "not started"],
    ["part reviewed", record(2, 5), REPORT, "2 of 5 reviewed"],
    ["reviewed", record(5, 5), REPORT, "✓ reviewed"],
    ["with nothing to mark", record(0, 0), REPORT, "nothing to mark as reviewed"],
    ["reviewed, with comments not posted", record(5, 5, 2), REPORT, "✓ reviewed, 2 comments not posted"],
    ["reviewed before new commits", record(5, 5), { ...REPORT, headSha: commitShaSchema.parse("b".repeat(40)) }, "changed since you reviewed it"],
    ["reviewed before a retarget", record(2, 5, 1), { ...REPORT, baseRef: "release" }, "changed since you reviewed it, 1 comment not posted"],
    ["reviewed before the report was kept", record(5, 5), null, "changed since you reviewed it"],
  ])("reads %s", (_case, saved, current, label) => {
    expect(progressLabel(progressOf(saved, current))).toBe(label)
  })
})
