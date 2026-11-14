import type { ReactElement } from "react"
import { AiReviewStatus, CitationSide, IntentVerdict } from "@walkdiff/review-model"
import type { AiReview, Citation, PullRequest } from "@walkdiff/review-model"
import { digestAiReview } from "../aiDigest.ts"
import type { AiDigest } from "../aiDigest.ts"
import { sourceLineUrl } from "../sourceLinks.ts"
import { HostLink } from "./HostLink.tsx"

const VERDICT_LABELS: Readonly<Record<IntentVerdict, string>> = {
  [IntentVerdict.Matches]: "Matches",
  [IntentVerdict.Contradicts]: "Contradicts",
  [IntentVerdict.Undocumented]: "Not in description",
  [IntentVerdict.NotFound]: "Not found in code",
}

interface AiReviewViewProps {
  readonly ai: AiReview
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

/** The model's intent check, questions and reading order; pointers for the reviewer, not verdicts. */
export function AiReviewView({ ai, pullRequest, onOpenFile }: AiReviewViewProps): ReactElement {
  switch (ai.status) {
    case AiReviewStatus.Disabled:
      return <p className="ai-note">AI review is off. Tick Include AI review in the app, or run with --ai, to check the code against the description and get questions to answer.</p>
    case AiReviewStatus.Unavailable:
      return <p className="ai-note">AI review was requested but not produced: {ai.reason}.</p>
    case AiReviewStatus.Completed:
      return <CompletedAiReview ai={ai} pullRequest={pullRequest} onOpenFile={onOpenFile} />
  }
}

type CompletedReview = Extract<AiReview, { status: typeof AiReviewStatus.Completed }>

interface CompletedAiReviewProps {
  readonly ai: CompletedReview
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

/**
 * Leads with what a reviewer has to act on, one line each. Explanations open on demand, and the
 * reading order comes last, since the review path already gives an order to work in.
 */
function digestCompleted(ai: CompletedReview): AiDigest {
  return digestAiReview(ai) ?? { mismatches: [], matches: [], questions: [] }
}

function CompletedAiReview({ ai, pullRequest, onOpenFile }: CompletedAiReviewProps): ReactElement {
  const { mismatches, matches, questions } = digestCompleted(ai)
  return (
    <section className="ai-review">
      <h2 className="section-title">Doesn't match the description ({mismatches.length})</h2>
      {mismatches.length === 0 ? (
        <p className="notice">The AI found no differences between the description and the code.</p>
      ) : (
        <ul className="ai-points">
          {mismatches.map((finding) => (
            <AiPoint key={finding.claim} badge={finding.verdict} title={finding.claim} detail={finding.explanation} citations={finding.citations} pullRequest={pullRequest} onOpenFile={onOpenFile} />
          ))}
        </ul>
      )}

      <h2 className="section-title">Questions to answer before approving ({questions.length})</h2>
      <ol className="ai-points">
        {questions.map((question) => (
          <AiPoint key={question.question} badge={undefined} title={question.question} detail={question.why} citations={question.citations} pullRequest={pullRequest} onOpenFile={onOpenFile} />
        ))}
      </ol>

      {matches.length > 0 && (
        <details className="ai-more">
          <summary>
            {matches.length} {matches.length === 1 ? "claim matches" : "claims match"} the code
          </summary>
          <ul className="ai-points">
            {matches.map((finding) => (
              <AiPoint key={finding.claim} badge={undefined} title={finding.claim} detail={finding.explanation} citations={finding.citations} pullRequest={pullRequest} onOpenFile={onOpenFile} />
            ))}
          </ul>
        </details>
      )}

      <details className="ai-more">
        <summary>Suggested reading order ({ai.chapters.length} groups)</summary>
        <ol className="ai-chapters">
          {ai.chapters.map((chapter) => (
            <li key={chapter.title}>
              <details>
                <summary>
                  <strong>{chapter.title}</strong> <span className="chapter-path">{chapter.units.length} {chapter.units.length === 1 ? "unit" : "units"}</span>
                </summary>
                <p className="chapter-summary">{chapter.summary}</p>
                <ul className="chapter-units">
                  {chapter.units.map((unit) => (
                    <li key={`${unit.path}:${unit.qualifiedName}`}>
                      <button type="button" className="link-button" onClick={() => onOpenFile(unit.path)}>
                        {unit.qualifiedName}
                      </button>{" "}
                      <span className="chapter-path">{unit.path}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ol>
      </details>

      <p className="ai-note">
        Written by {ai.model}. Every point cites lines of this change, so treat them as pointers, not verdicts.
        {ai.droppedStatements > 0 && ` ${ai.droppedStatements} without valid citations ${ai.droppedStatements === 1 ? "was" : "were"} discarded.`}
        {ai.unitsSummarizedOnly > 0 && ` ${ai.unitsSummarizedOnly} ${ai.unitsSummarizedOnly === 1 ? "unit was" : "units were"} sent by name only, to stay within the input budget.`}
      </p>
    </section>
  )
}

interface AiPointProps {
  readonly badge: IntentVerdict | undefined
  readonly title: string
  readonly detail: string
  readonly citations: readonly Citation[]
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

function AiPoint({ badge, title, detail, citations, pullRequest, onOpenFile }: AiPointProps): ReactElement {
  return (
    <li className="ai-point">
      <details>
        <summary>
          {badge !== undefined && <span className={`verdict verdict-${badge}`}>{VERDICT_LABELS[badge]}</span>} <span className="ai-item-title">{title}</span>
        </summary>
        <p className="ai-item-detail">{detail}</p>
        <Citations citations={citations} pullRequest={pullRequest} onOpenFile={onOpenFile} />
      </details>
    </li>
  )
}

interface CitationsProps {
  readonly citations: readonly Citation[]
  readonly pullRequest: PullRequest
  readonly onOpenFile: (path: string) => void
}

function Citations({ citations, pullRequest, onOpenFile }: CitationsProps): ReactElement | null {
  if (citations.length === 0) return null
  return (
    <ul className="citations">
      {citations.map((citation) => {
        const lines = citation.startLine === citation.endLine ? `${citation.startLine}` : `${citation.startLine}-${citation.endLine}`
        const label = `${citation.path}:${lines}${citation.side === CitationSide.Before ? " (before)" : ""}`
        return (
          <li key={`${citation.path}:${citation.side}:${citation.startLine}:${citation.endLine}`}>
            <button type="button" className="link-button" onClick={() => onOpenFile(citation.path)}>
              {label}
            </button>
            <HostLink url={sourceLineUrl(pullRequest, citation.path, citation.startLine, citation.side)} />
          </li>
        )
      })}
    </ul>
  )
}
