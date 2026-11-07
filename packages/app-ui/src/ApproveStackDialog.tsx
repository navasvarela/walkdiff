import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import { ApprovalOutcome, numberLabel } from "@walkdiff/review-model"
import type { BlockedMember, MemberApproval, ReviewSummary, StackView } from "@walkdiff/review-model"
import { ApprovalAnswerKind, approveStack, checkStackApproval } from "./api.ts"
import { approveInTurn } from "./approveInTurn.ts"
import { readProgress } from "./progress.ts"
import { approvalCheck, isWebLink } from "./stackList.ts"
import type { ApprovalCheck } from "./stackList.ts"

const SHORT_SHA_LENGTH = 7

const Phase = { Confirm: "confirm", Posting: "posting", Results: "results", Blocked: "blocked" } as const

type DialogState =
  | { readonly phase: typeof Phase.Confirm }
  /** `current` is undefined while every member is checked, before any is posted. */
  | { readonly phase: typeof Phase.Posting; readonly results: readonly MemberApproval[]; readonly current: number | undefined }
  | { readonly phase: typeof Phase.Results; readonly results: readonly MemberApproval[] }
  | { readonly phase: typeof Phase.Blocked; readonly blocked: readonly BlockedMember[] }

interface ApproveStackDialogProps {
  readonly stackId: number
  /** The open members, bottom first. */
  readonly members: readonly ReviewSummary[]
  readonly view: StackView
  readonly onClose: () => void
  /** Runs once approvals were posted, so the card can show who approved. */
  readonly onPosted: () => void
}

/**
 * Confirms approving every open member, then shows what happened to each. The server checks every
 * member again before posting any, and a refusal from the host doesn't stop the others.
 */
export function ApproveStackDialog({ stackId, members, view, onClose, onPosted }: ApproveStackDialogProps): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const [body, setBody] = useState("")
  const [state, setState] = useState<DialogState>({ phase: Phase.Confirm })
  const [problem, setProblem] = useState<string>()
  useEffect(() => dialog.current?.showModal(), [])

  const checks = new Map(members.map((member) => [member.id, approvalCheck(view.members.find((status) => status.reviewId === member.id), readProgress(member))]))
  const refused = state.phase === Phase.Results ? state.results.filter((result) => result.outcome === ApprovalOutcome.Refused).map((result) => result.reviewId) : []
  // A retry goes to the refused members only; the first attempt to every open one.
  const targets = state.phase === Phase.Results ? members.filter((member) => refused.includes(member.id)) : members
  const blocked = targets.some((member) => !(checks.get(member.id)?.ready ?? false))

  const post = async (): Promise<void> => {
    const chosen = targets.flatMap((member) => {
      const check = checks.get(member.id)
      return check?.ready === true ? [{ reviewId: member.id, headSha: check.headSha }] : []
    })
    const before = state
    // After a retry, the members that weren't retried keep their first results.
    let results = (state.phase === Phase.Results ? state.results : []).filter((result) => !chosen.some((member) => member.reviewId === result.reviewId))
    setState({ phase: Phase.Posting, results, current: undefined })
    setProblem(undefined)
    try {
      const run = await approveInTurn(
        { body, members: chosen },
        { check: (request) => checkStackApproval(stackId, request), approve: (request) => approveStack(stackId, request) },
        {
          posting: (reviewId) => setState({ phase: Phase.Posting, results, current: reviewId }),
          posted: (result) => {
            results = [...results, result]
            setState({ phase: Phase.Posting, results, current: undefined })
          },
        },
      )
      if (run.kind === ApprovalAnswerKind.Blocked) {
        setState({ phase: Phase.Blocked, blocked: run.blocked })
        return
      }
      setState({ phase: Phase.Results, results })
      onPosted()
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error))
      setState(before)
    }
  }

  const resultOf = (member: ReviewSummary): MemberApproval | undefined => (state.phase === Phase.Results || state.phase === Phase.Posting ? state.results.find((result) => result.reviewId === member.id) : undefined)
  const blockedOf = (member: ReviewSummary): string | undefined => (state.phase === Phase.Blocked ? state.blocked.find((entry) => entry.reviewId === member.id)?.reason : undefined)
  const stepOf = (member: ReviewSummary): PostingStep | undefined => {
    if (state.phase !== Phase.Posting || state.current === undefined || resultOf(member) !== undefined) return undefined
    return member.id === state.current ? PostingStep.Posting : PostingStep.Waiting
  }

  return (
    <dialog
      ref={dialog}
      className="approve-dialog"
      aria-labelledby="approve-title"
      onClose={onClose}
      // Closing wouldn't stop approvals already on their way, so it waits until they are done.
      onCancel={(event) => state.phase === Phase.Posting && event.preventDefault()}
    >
      <h2 id="approve-title">Approve {members.length === 1 ? "this PR" : `all ${members.length} PRs`}</h2>
      <p className="approve-lede">Each gets its own approval, for the commit its report shows, posted bottom first.</p>
      <ol className="approve-members">
        {members.map((member) => (
          <li key={member.id}>
            <MemberLine member={member} check={checks.get(member.id)} result={resultOf(member)} blockedReason={blockedOf(member)} step={stepOf(member)} />
          </li>
        ))}
      </ol>
      {state.phase === Phase.Blocked && <p className="problem">Nothing was posted: some PRs changed since the card last checked. Close this, use Refresh changed, and look again.</p>}
      {state.phase !== Phase.Results && state.phase !== Phase.Blocked && (
        <label className="approve-body">
          Comment to post with each approval (optional)
          <textarea value={body} rows={3} disabled={state.phase === Phase.Posting} onChange={(event) => setBody(event.target.value)} />
        </label>
      )}
      {problem !== undefined && <p className="problem">{problem}</p>}
      <div className="review-actions">
        {(state.phase === Phase.Confirm || state.phase === Phase.Posting || refused.length > 0) && (
          <button type="button" className="primary" disabled={blocked || state.phase === Phase.Posting} onClick={() => void post()}>
            {state.phase === Phase.Posting ? postingLabel(state.current) : refused.length > 0 ? `Retry ${refused.length} that failed` : `Approve ${members.length === 1 ? "it" : `all ${members.length}`}`}
          </button>
        )}
        <button type="button" disabled={state.phase === Phase.Posting} onClick={() => dialog.current?.close()}>
          {state.phase === Phase.Results || state.phase === Phase.Blocked ? "Close" : "Cancel"}
        </button>
      </div>
    </dialog>
  )
}

function postingLabel(current: number | undefined): string {
  return current === undefined ? "Checking…" : "Posting…"
}

const PostingStep = { Posting: "posting", Waiting: "waiting" } as const
type PostingStep = (typeof PostingStep)[keyof typeof PostingStep]

const POSTING_STEP_LABELS: Readonly<Record<PostingStep, string>> = { [PostingStep.Posting]: "Posting…", [PostingStep.Waiting]: "Waiting" }

interface MemberNoteProps {
  readonly check: ApprovalCheck | undefined
  readonly result: MemberApproval | undefined
  readonly blockedReason: string | undefined
  readonly step: PostingStep | undefined
}

interface MemberLineProps extends MemberNoteProps {
  readonly member: ReviewSummary
}

function MemberLine({ member, check, result, blockedReason, step }: MemberLineProps): ReactElement {
  return (
    <>
      <span className="approve-member">
        {numberLabel(member.host, member.number)} {member.title ?? member.displayName}
        {check?.ready === true && <code className="approve-sha">{check.headSha.slice(0, SHORT_SHA_LENGTH)}</code>}
      </span>
      <MemberNote check={check} result={result} blockedReason={blockedReason} step={step} />
    </>
  )
}

/** What happened to the member, else what stops it, else where posting has got to, else what to watch for. */
function MemberNote({ check, result, blockedReason, step }: MemberNoteProps): ReactElement | null {
  if (result !== undefined) return <ApprovalResult result={result} />
  if (blockedReason !== undefined) return <p className="member-state-problem">{blockedReason}</p>
  if (step !== undefined) return <p className="member-state-muted">{POSTING_STEP_LABELS[step]}</p>
  if (check === undefined) return null
  if (!check.ready) return <p className="member-state-problem">{check.blocker}</p>
  return (
    <>
      {check.warnings.map((warning) => (
        <p key={warning} className="member-state-attention">
          {warning}
        </p>
      ))}
    </>
  )
}

function ApprovalResult({ result }: { readonly result: MemberApproval }): ReactElement {
  if (result.outcome === ApprovalOutcome.Refused) return <p className="member-state-problem">✗ Not approved: {result.error}</p>
  return (
    <p className="member-state-good">
      ✓ Approved
      {isWebLink(result.url) && (
        <>
          {" · "}
          <a href={result.url} target="_blank" rel="noreferrer">
            View
          </a>
        </>
      )}
    </p>
  )
}
