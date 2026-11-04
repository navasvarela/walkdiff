import { useState } from "react"
import type { ReactElement } from "react"
import { GitHostKind, ReviewEvent, submitReviewSchema } from "@walkdiff/review-model"
import type { ReviewModel, SubmitReview } from "@walkdiff/review-model"
import { isWebLink, postReview } from "../appApi.ts"
import { useReloadConversation } from "../conversationState.tsx"
import { reviewCommentsFrom } from "../reviewProgress.ts"
import type { ItemComment } from "../reviewProgress.ts"
import { lineCommentKey } from "../lineComments.ts"
import type { LineComment } from "../lineComments.ts"
import { useReviewState } from "../reviewState.tsx"
import { CommentList } from "./CommentList.tsx"

const HOST_LABELS: Readonly<Record<GitHostKind, string>> = { [GitHostKind.GitHub]: "GitHub", [GitHostKind.GitLab]: "GitLab" }

const EVENTS: readonly { readonly event: ReviewEvent; readonly label: string; readonly hint: string }[] = [
  { event: ReviewEvent.Comment, label: "Comment", hint: "Share your thoughts without a decision" },
  { event: ReviewEvent.Approve, label: "Approve", hint: "This is good to merge" },
  { event: ReviewEvent.RequestChanges, label: "Request changes", hint: "This needs changes before it can merge" },
]

interface SubmitReviewFormProps {
  readonly review: ReviewModel
  readonly comments: readonly ItemComment[]
  readonly lineComments: readonly LineComment[]
}

/** The one place Walkdiff changes anything on the host, and only when this button is pressed. */
export function SubmitReviewForm({ review, comments, lineComments }: SubmitReviewFormProps): ReactElement {
  const { setComment } = useReviewState()
  const reload = useReloadConversation()
  const [event, setEvent] = useState<ReviewEvent>(ReviewEvent.Comment)
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [postedUrl, setPostedUrl] = useState<string>()
  const host = HOST_LABELS[review.pullRequest.host]
  const draft: SubmitReview = { event, body, headSha: review.pullRequest.headSha, comments: reviewCommentsFrom(comments, lineComments, review.files) }
  const validation = submitReviewSchema.safeParse(draft)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      const { url } = await postReview(draft)
      // Cleared only now, so a failure never loses what someone wrote.
      comments.forEach(({ item }) => setComment(item.id, ""))
      lineComments.forEach(({ path, range }) => setComment(lineCommentKey(path, range), ""))
      setBody("")
      setPostedUrl(url)
      await reload()
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="guide-panel guide-submit" aria-labelledby="guide-submit-title">
      <h2 id="guide-submit-title" className="guide-heading">
        Submit your review
      </h2>
      {comments.length + lineComments.length > 0 && <CommentList comments={comments} lineComments={lineComments} />}
      <textarea rows={3} value={body} aria-label="Review summary" placeholder="Leave a summary (optional)" onChange={(change) => setBody(change.target.value)} />
      <fieldset className="guide-submit-events">
        <legend className="sr-only">Your decision</legend>
        {EVENTS.map((option) => (
          <label key={option.event}>
            <input type="radio" name="review-event" checked={event === option.event} onChange={() => setEvent(option.event)} />
            <span>
              <strong>{option.label}</strong>
              <span className="guide-submit-hint">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="guide-submit-row">
        <button type="button" className="guide-button guide-button-primary" disabled={busy || !validation.success} onClick={() => void submit()}>
          {busy ? "Posting…" : `Post to ${host}`}
        </button>
        {!validation.success && <span className="guide-note">{validation.error.issues.at(0)?.message}</span>}
        {postedUrl !== undefined && (
          <span className="guide-submit-posted">
            ✓ Posted.{" "}
            {isWebLink(postedUrl) && (
              <a href={postedUrl} target="_blank" rel="noreferrer">
                See it on {host}
              </a>
            )}
          </span>
        )}
      </div>
      {problem !== undefined && <p className="guide-error">{problem}</p>}
    </section>
  )
}
