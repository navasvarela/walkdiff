import { describe, expect, it } from "vitest"
import { commitShaSchema } from "@walkdiff/review-model"
import type { ApproveStackRequest, MemberApproval } from "@walkdiff/review-model"
import type { ApprovalAnswer, CheckAnswer } from "./api.ts"
import { approveInTurn } from "./approveInTurn.ts"
import type { ApprovalCalls } from "./approveInTurn.ts"

const HEAD = commitShaSchema.parse("a".repeat(40))
const request: ApproveStackRequest = { body: "LGTM", members: [3, 4, 5].map((reviewId) => ({ reviewId, headSha: HEAD })) }
const ready: CheckAnswer = { kind: "ready" }
const posted = (reviewId: number): ApprovalAnswer => ({ kind: "done", result: { results: [{ outcome: "posted", reviewId, url: `https://gitlab.com/g/p/-/merge_requests/${reviewId}` }] } })

/** Runs an approval with the given answers, recording what was asked and what the listener heard. */
async function run(check: () => Promise<CheckAnswer>, approve: (reviewId: number) => Promise<ApprovalAnswer>): Promise<{ readonly heard: string[]; readonly results: MemberApproval[]; readonly asked: ApproveStackRequest[]; readonly outcome: unknown }> {
  const heard: string[] = []
  const results: MemberApproval[] = []
  const asked: ApproveStackRequest[] = []
  const calls: ApprovalCalls = {
    check,
    approve: async (one) => {
      asked.push(one)
      return approve(one.members[0]?.reviewId ?? 0)
    },
  }
  const listener = { posting: (reviewId: number): void => void heard.push(`posting ${reviewId}`), posted: (result: MemberApproval): void => {
      heard.push(`${result.outcome} ${result.reviewId}`)
      results.push(result)
    },
  }
  const outcome = await approveInTurn(request, calls, listener)
  return { heard, results, asked, outcome }
}

describe("approving a stack one PR at a time", () => {
  it("checks them all, then posts each in order, saying as each starts and ends", async () => {
    const { heard, asked, outcome } = await run(async () => ready, async (reviewId) => posted(reviewId))
    expect(outcome).toEqual({ kind: "done" })
    expect(heard).toEqual(["posting 3", "posted 3", "posting 4", "posted 4", "posting 5", "posted 5"])
    expect(asked).toEqual(request.members.map((member) => ({ body: "LGTM", members: [member] })))
  })

  it("posts nothing when the check blocks", async () => {
    const blocked: CheckAnswer = { kind: "blocked", blocked: { error: "Nothing was posted", blocked: [{ reviewId: 4, reason: "It has new commits." }] } }
    const { heard, asked, outcome } = await run(async () => blocked, async (reviewId) => posted(reviewId))
    expect(outcome).toEqual({ kind: "blocked", blocked: [{ reviewId: 4, reason: "It has new commits." }] })
    expect(heard).toEqual([])
    expect(asked).toEqual([])
  })

  it.each([
    ["changed after the check", async (): Promise<ApprovalAnswer> => ({ kind: "blocked", blocked: { error: "Nothing was posted", blocked: [{ reviewId: 4, reason: "It has new commits." }] } }), "It has new commits."],
    ["unreachable", async (): Promise<ApprovalAnswer> => Promise.reject(new Error("Failed to fetch")), "Failed to fetch"],
  ])("keeps going past a PR %s, counting it as not approved", async (_case, failing, error) => {
    const { heard, results, outcome } = await run(async () => ready, async (reviewId) => (reviewId === 4 ? failing() : posted(reviewId)))
    expect(outcome).toEqual({ kind: "done" })
    expect(heard).toEqual(["posting 3", "posted 3", "posting 4", "refused 4", "posting 5", "posted 5"])
    expect(results.at(1)).toEqual({ outcome: "refused", reviewId: 4, error })
  })
})
