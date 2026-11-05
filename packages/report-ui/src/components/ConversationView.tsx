import { useState } from "react"
import type { ReactElement } from "react"
import { DiffLineKind, LineSide, ReviewerState } from "@walkdiff/review-model"
import type { ChangedFile, DiffLine, ReviewThread } from "@walkdiff/review-model"
import { isWebLink, replyToThread, setThreadResolved } from "../appApi.ts"
import { useConversation, useReloadConversation } from "../conversationState.tsx"
import type { ReviewStop } from "../reviewPlan.ts"
import { isThreadOnStop, threadContext, threadTarget } from "../threadPlaces.ts"
import type { ContextLine, LinePlace } from "../threadPlaces.ts"

// Long enough to recognise a comment in a collapsed thread, short enough to keep one line.
const EXCERPT_CHARS = 90

/** Collapsed threads make a long discussion scannable; beside the code, they start open. */
export const ThreadDisplay = { Open: "open", Collapsed: "collapsed" } as const
export type ThreadDisplay = (typeof ThreadDisplay)[keyof typeof ThreadDisplay]

const LINE_MARKERS: Readonly<Record<DiffLineKind, string>> = {
  [DiffLineKind.Added]: "+",
  [DiffLineKind.Removed]: "−",
  [DiffLineKind.Context]: " ",
}

const STATE_LABELS: Readonly<Record<ReviewerState, string>> = {
  [ReviewerState.Approved]: "approved",
  [ReviewerState.ChangesRequested]: "requested changes",
  [ReviewerState.Commented]: "commented",
  [ReviewerState.Other]: "reviewing",
}

/** Who has weighed in, on the brief. Silent until there's something to say. */
export function ReviewerSummary(): ReactElement | null {
  const load = useConversation()
  if (load.status !== "loaded" || load.conversation.reviewers.length === 0) return null
  return (
    <ul className="reviewer-summary" aria-label="Reviews so far">
      {load.conversation.reviewers.map((reviewer) => (
        <li key={reviewer.name} className={`reviewer-badge reviewer-badge-${reviewer.state}`}>
          {reviewer.name} {STATE_LABELS[reviewer.state]}
        </li>
      ))}
    </ul>
  )
}

interface StopThreadsProps {
  readonly stop: ReviewStop
  readonly files: readonly ChangedFile[]
}

/** The discussion already on a change, beside its code. */
export function StopThreads({ stop, files }: StopThreadsProps): ReactElement | null {
  const load = useConversation()
  if (load.status !== "loaded") return null
  const threads = load.conversation.threads.filter((thread) => isThreadOnStop(thread, stop))
  if (threads.length === 0) return null
  return (
    <section className="guide-section">
      <h2 className="guide-heading">Discussion</h2>
      {threads.map((thread) => (
        <ThreadCard key={thread.id} thread={thread} files={files} display={ThreadDisplay.Open} onOpenLine={undefined} />
      ))}
    </section>
  )
}

/** Shows a file in the Changes tab, scrolled to a line when there is one. */
export type OpenLine = (path: string, place: LinePlace | undefined) => void

interface ConversationViewProps {
  readonly files: readonly ChangedFile[]
  readonly onOpenLine: OpenLine
}

export function ConversationView({ files, onOpenLine }: ConversationViewProps): ReactElement {
  const load = useConversation()
  switch (load.status) {
    case "unavailable":
      return <p className="notice">Open this review in the Walkdiff app to see and join the discussion.</p>
    case "loading":
      return <p className="notice">Reading the discussion…</p>
    case "failed":
      return <p className="guide-error">{load.message}</p>
    case "loaded": {
      const open = load.conversation.threads.filter((thread) => !thread.isResolved)
      const resolved = load.conversation.threads.filter((thread) => thread.isResolved)
      return (
        <section className="conversation">
          <ReviewerSummaryBlock />
          {load.conversation.threads.length === 0 && <p className="notice">No discussion on the code yet.</p>}
          {open.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} files={files} display={ThreadDisplay.Collapsed} onOpenLine={onOpenLine} />
          ))}
          {resolved.length > 0 && (
            <details>
              <summary>{resolved.length} resolved</summary>
              {resolved.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} files={files} display={ThreadDisplay.Collapsed} onOpenLine={onOpenLine} />
              ))}
            </details>
          )}
          {load.conversation.truncated && <p className="notice">There's more on the PR than Walkdiff read. See the PR for the rest.</p>}
        </section>
      )
    }
  }
}

function ReviewerSummaryBlock(): ReactElement {
  return (
    <div className="conversation-reviewers">
      <ReviewerSummary />
    </div>
  )
}

interface ThreadCardProps {
  readonly thread: ReviewThread
  readonly files: readonly ChangedFile[]
  readonly display: ThreadDisplay
  /** Shows the thread's line in the Changes tab; undefined where there's no such tab. */
  readonly onOpenLine: OpenLine | undefined
}

function ThreadCard({ thread, files, display, onOpenLine }: ThreadCardProps): ReactElement {
  const reload = useReloadConversation()
  const [reply, setReply] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      await action()
      await reload()
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const target = threadTarget(files, thread)
  return (
    <details className={thread.isResolved ? "thread thread-resolved" : "thread"} open={display === ThreadDisplay.Open}>
      <ThreadSummary thread={thread} />
      {thread.path !== null && (
        <div className="thread-code">
          <ThreadCode thread={thread} files={files} />
          {onOpenLine !== undefined && target !== undefined && (
            <button type="button" className="link-button" onClick={() => onOpenLine(target.path, target.place)}>
              {target.place === undefined ? `Open ${target.path} in Changes` : `Show line ${target.place.line} in Changes`}
            </button>
          )}
        </div>
      )}
      {thread.comments.map((comment) => (
        <div key={`${comment.author}:${comment.createdAt}`} className="thread-comment">
          <span className="thread-author">
            {isWebLink(comment.url) ? (
              <a href={comment.url} target="_blank" rel="noreferrer">
                {comment.author}
              </a>
            ) : (
              comment.author
            )}
          </span>
          <p>{comment.body}</p>
        </div>
      ))}
      <div className="thread-actions">
        <textarea rows={2} value={reply} aria-label="Your reply" placeholder="Reply" onChange={(event) => setReply(event.target.value)} />
        <button
          type="button"
          disabled={busy || reply.trim() === ""}
          onClick={() =>
            void act(async () => {
              await replyToThread(thread.id, reply)
              setReply("")
            })
          }
        >
          Post reply
        </button>
        <button type="button" disabled={busy} onClick={() => void act(() => setThreadResolved(thread.id, !thread.isResolved))}>
          {thread.isResolved ? "Reopen" : "Resolve"}
        </button>
      </div>
      {problem !== undefined && <p className="guide-error">{problem}</p>}
    </details>
  )
}

function ThreadSummary({ thread }: { readonly thread: ReviewThread }): ReactElement {
  const first = thread.comments.at(0)
  const replies = thread.comments.length - 1
  return (
    <summary className="thread-summary">
      {thread.path !== null && <span className="thread-place">{placeOf(thread)}</span>}
      {first !== undefined && (
        <span className="thread-excerpt">
          <strong>{first.author}</strong> {excerptOf(first.body)}
        </span>
      )}
      <span className="thread-tags">
        {replies > 0 && <span className="thread-tag">{replies === 1 ? "1 reply" : `${replies} replies`}</span>}
        {thread.isOutdated && <span className="thread-tag">outdated</span>}
        {thread.isResolved && <span className="thread-tag">resolved</span>}
      </span>
    </summary>
  )
}

function ThreadCode({ thread, files }: { readonly thread: ReviewThread; readonly files: readonly ChangedFile[] }): ReactElement | null {
  const context = threadContext(files, thread)
  if (context === undefined) {
    return thread.line === null ? null : <p className="thread-no-context">This line isn't in the diff Walkdiff read. Open the PR to see it.</p>
  }
  return (
    <table className="thread-context" aria-label={`Code around ${placeOf(thread)}`}>
      <tbody>
        {context.map((entry) => (
          <ContextRow key={`${entry.line.kind}:${lineNumberOf(entry.line)}`} entry={entry} />
        ))}
      </tbody>
    </table>
  )
}

function ContextRow({ entry }: { readonly entry: ContextLine }): ReactElement {
  const { line, isCommented } = entry
  return (
    <tr className={`thread-context-${line.kind}${isCommented ? " thread-context-commented" : ""}`} aria-current={isCommented ? "true" : undefined}>
      <td className="thread-context-number">{lineNumberOf(line)}</td>
      <td className="thread-context-marker">{LINE_MARKERS[line.kind]}</td>
      <td className="thread-context-text">
        <code>{line.content}</code>
      </td>
    </tr>
  )
}

function lineNumberOf(line: DiffLine): number {
  return line.kind === DiffLineKind.Removed ? line.oldLine : line.newLine
}

function placeOf(thread: ReviewThread): string {
  const line = thread.line === null ? "" : `:${thread.line}`
  return `${thread.path ?? ""}${line}${thread.side === LineSide.Old && thread.line !== null ? " (before)" : ""}`
}

function excerptOf(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim()
  return oneLine.length > EXCERPT_CHARS ? `${oneLine.slice(0, EXCERPT_CHARS - 1)}…` : oneLine
}
