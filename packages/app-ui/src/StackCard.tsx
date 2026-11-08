import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import { numberLabel } from "@walkdiff/review-model"
import type { AiDestination, ReviewSummary, StackMemberStatus, StackView } from "@walkdiff/review-model"
import { loadStack, refreshStack, ungroupStack } from "./api.ts"
import { ApproveStackDialog } from "./ApproveStackDialog.tsx"
import { ReviewRow } from "./ReviewRow.tsx"
import type { ReviewActions } from "./ReviewRow.tsx"
import { doneState, isDone, isWorking, memberStateLabels, stackHeadline } from "./stackList.ts"

interface StackCardProps {
  readonly id: number
  /** Bottom first. */
  readonly members: readonly ReviewSummary[]
  readonly reviews: readonly ReviewSummary[]
  readonly destination: AiDestination | undefined
  readonly actionsFor: (review: ReviewSummary) => ReviewActions
  /** Runs a stack action, then reloads the list. */
  readonly act: (action: () => Promise<void>) => void
}

/**
 * A grouped stack as one card, bottom first. What each host says of its member is read when the
 * card shows and after each analysis, not polled: it takes a request or two per member.
 */
export function StackCard({ id, members, reviews, destination, actionsFor, act }: StackCardProps): ReactElement {
  const [view, setView] = useState<StackView>()
  const [problem, setProblem] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [approving, setApproving] = useState(false)

  // Read again once analyses finish, since they change what's out of date.
  const busy = members.some(isWorking)
  const settled = busy ? "busy" : members.map((member) => `${member.id}@${member.updatedAt}`).join()
  useEffect(() => {
    if (settled === "busy") return
    let current = true
    loadStack(id)
      .then((loaded) => {
        if (!current) return
        setView(loaded)
        setProblem(undefined)
      })
      .catch((error: unknown) => current && setProblem(error instanceof Error ? error.message : String(error)))
    return () => {
      current = false
    }
  }, [id, settled])

  const statusOf = (review: ReviewSummary): StackMemberStatus | undefined => view?.members.find((member) => member.reviewId === review.id)
  const open = members.filter((member) => !isDone(statusOf(member)))
  const done = members.filter((member) => isDone(statusOf(member)))
  const trunk = view?.trunk

  const refreshChanged = (): void => {
    setRefreshing(true)
    act(async () => {
      try {
        setView(await refreshStack(id))
      } finally {
        setRefreshing(false)
      }
    })
  }

  return (
    <section className="stack-card" aria-label={`Stack of ${members.length}`}>
      <div className="stack-header">
        <h2>
          Stack{trunk !== undefined && <> into <code>{trunk}</code></>}
        </h2>
        <span className="stack-headline">{stackHeadline(members, view)}</span>
        <div className="review-actions">
          <button type="button" disabled={view === undefined || busy || open.length === 0} onClick={() => setApproving(true)} title="Posts an approval to each open PR in the stack, after a confirmation">
            Approve all…
          </button>
          <button type="button" disabled={busy || refreshing} onClick={refreshChanged} title="Asks the host what changed, and analyzes again only the PRs whose reports are out of date">
            Refresh changed
          </button>
          <button type="button" onClick={() => act(() => ungroupStack(id))} title="Keeps the reviews, as separate rows">
            Ungroup
          </button>
        </div>
      </div>
      {problem !== undefined && <p className="problem">{problem}</p>}
      {approving && view !== undefined && (
        <ApproveStackDialog
          stackId={id}
          members={open}
          view={view}
          onClose={() => setApproving(false)}
          // Read again, so the card shows the new approvals.
          onPosted={() => void loadStack(id).then(setView, (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))}
        />
      )}
      <ol className="stack-members">
        {open.map((member) => (
          <li key={member.id}>
            <ReviewRow
              review={member}
              reviews={reviews}
              destination={destination}
              actions={actionsFor(member)}
              // Counts done members too, so it matches the strip in each report.
              badge={<span className="stack-position" title="Its place in the stack, from the bottom">{members.indexOf(member) + 1}/{members.length}</span>}
            >
              <MemberState status={statusOf(member)} working={isWorking(member)} />
            </ReviewRow>
          </li>
        ))}
      </ol>
      {done.length > 0 && (
        <p className="stack-done">
          Done:{" "}
          {done.map((member, index) => (
            <span key={member.id}>
              {index > 0 && " · "}
              <a href={member.url} target="_blank" rel="noreferrer">
                {numberLabel(member.host, member.number)} {member.title ?? member.displayName}
              </a>{" "}
              ({doneState(statusOf(member))})
            </span>
          ))}
        </p>
      )}
    </section>
  )
}

function MemberState({ status, working }: { readonly status: StackMemberStatus | undefined; readonly working: boolean }): ReactElement | null {
  // While it's being analyzed, what the host says of the old report is about to change.
  if (status === undefined || working) return null
  const labels = memberStateLabels(status)
  if (labels.length === 0) return null
  return (
    <p className="member-state">
      {labels.map((label) => (
        <span key={label.text} className={`member-state-${label.tone}`}>
          {label.text}
        </span>
      ))}
    </p>
  )
}
