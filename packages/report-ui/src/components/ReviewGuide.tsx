import { useEffect, useMemo, useState } from "react"
import type { ReactElement } from "react"
import { AiReviewStatus, CheckOutcome, namesOfChecks, summarizeChecks, UnitChangeKind, UnitImpactStatus } from "@walkdiff/review-model"
import type { ChangedUnit, CheckRun, ReviewModel, RiskAssessment, SkippedCheck } from "@walkdiff/review-model"
import { aiNotesForStop, digestAiReview } from "../aiDigest.ts"
import { lineCommentsIn } from "../lineComments.ts"
import type { LineComment } from "../lineComments.ts"
import { isConnectedToApp } from "../appApi.ts"
import { changeSummary, FINISH_HASH, GuideRouteKind, hashForStop, PATH_RULES, REVIEW_HASH, StopCoverageKind } from "../reviewPlan.ts"
import type { GuideRoute, LineCoverage, ReviewPlan, ReviewStop } from "../reviewPlan.ts"
import { commentsAsMarkdown, commentsOnItems, isReviewed, ItemKind, nextUnreviewedStop, overallProgress, pathProgress, remainingOffPath, reviewPlanFor, stopItems } from "../reviewProgress.ts"
import type { ItemComment, Progress, RemainingCounts, ReviewState } from "../reviewProgress.ts"
import { useReviewState } from "../reviewState.tsx"
import { ReportTab } from "../tabs.ts"
import { factPhrases } from "../unitChange.ts"
import { SideBySide } from "./CodeViews.tsx"
import { useConversation } from "../conversationState.tsx"
import { openCommentsOnStop } from "../threadPlaces.ts"
import { ReviewerSummary, StopThreads } from "./ConversationView.tsx"
import { HunkView } from "./HunkView.tsx"
import { ImpactPanel } from "./ImpactPanel.tsx"
import { InlineCode } from "./InlineCode.tsx"
import { CommentList } from "./CommentList.tsx"
import { LineCommentPanel, LineCommentScopeProvider, WithoutLineComments } from "./LineComments.tsx"
import { ReviewControls } from "./ReviewControls.tsx"
import { SubmitReviewForm } from "./SubmitReviewForm.tsx"
import { TopBar, TopBarSection } from "./TopBar.tsx"
import { RiskList } from "./RiskView.tsx"
import { UnitBody } from "./UnitCard.tsx"

const ALL_CHANGES_HASH = "#changes"
const RISKS_HASH = `#${ReportTab.Risks}`
const AI_REVIEW_HASH = `#${ReportTab.AiReview}`
const NEXT_KEY = "j"
const PREVIOUS_KEY = "k"
const MARK_KEY = "r"
const PERCENT = 100
const COPY_CONFIRMATION_MS = 2_000
const MAX_UNCOVERED_LINES_NAMED = 8
const CopyResult = { None: "none", Copied: "copied", Failed: "failed" } as const
type CopyResult = (typeof CopyResult)[keyof typeof CopyResult]

interface ReviewGuideProps {
  readonly review: ReviewModel
  readonly route: GuideRoute
}

/** The guided review: a brief, one change at a time beside the full path, and a clear end. */
export function ReviewGuide({ review, route }: ReviewGuideProps): ReactElement {
  const { state, setReviewed, changedAtOpen } = useReviewState()
  const plan = useMemo(() => reviewPlanFor(review, changedAtOpen), [review, changedAtOpen])
  const current = route.kind === GuideRouteKind.Stop ? plan.stops.at(route.index) : undefined

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route])
  useKeyboardShortcuts(route, plan, current === undefined ? undefined : () => setReviewed(stopItems(current), !isReviewed(stopItems(current), state)))

  return (
    <>
      <TopBar review={review} section={TopBarSection.Review} />
      {route.kind === GuideRouteKind.Brief ? (
        <Brief review={review} plan={plan} state={state} />
      ) : (
        <div className="guide-with-rail">
          <ReviewRail review={review} plan={plan} state={state} currentIndex={route.kind === GuideRouteKind.Stop ? route.index : undefined} />
          {route.kind === GuideRouteKind.Stop && current !== undefined ? (
            <StopView review={review} stop={current} index={route.index} total={plan.stops.length} />
          ) : (
            <Finish review={review} plan={plan} state={state} />
          )}
        </div>
      )}
    </>
  )
}

function AllClear({ checks }: { readonly checks: readonly CheckRun[] }): ReactElement {
  return (
    <p className="guide-all-clear">
      <strong>No security findings or breaking changes.</strong> Checked with {namesOfChecks(checks)}. They can miss real problems, so this doesn't mean the change is safe.
    </p>
  )
}

function Brief({ review, plan, state }: { readonly review: ReviewModel; readonly plan: ReviewPlan; readonly state: ReviewState }): ReactElement {
  const { changedAtOpen } = useReviewState()
  return (
    <main className="guide">
      <BriefHeading review={review} />
      <div className="guide-columns">
        <div className="guide-main">
          <ReviewerSummary />

          {changedAtOpen.length > 0 && (
            <p className="guide-updated">
              <strong>This PR has changed since your last review.</strong> {changedAtOpen.length} {changedAtOpen.length === 1 ? "change you reviewed needs" : "changes you reviewed need"} another look.
            </p>
          )}

          <BriefStart plan={plan} state={state} />

          {plan.checks.length === 0 ? <AllClear checks={review.risk.checksRun} /> : <BriefChecks plan={plan} />}

          <OffPathWarning plan={plan} />
          <NotCheckedWarning checks={review.risk.notChecked} />
          <WhyThesePanel plan={plan} />
        </div>
        <BriefSidebar review={review} plan={plan} />
      </div>
    </main>
  )
}

function BriefHeading({ review }: { readonly review: ReviewModel }): ReactElement {
  const { pullRequest } = review
  return (
    <div className="guide-heading-block">
      <h1 className="guide-title">{pullRequest.title}</h1>
      <p className="guide-eyebrow">
        <strong>{pullRequest.author}</strong> wants to merge <code>{pullRequest.headRef}</code> into <code>{pullRequest.baseRef}</code>
      </p>
    </div>
  )
}

/** The one action on the page, with what it will take, so it reads as the way forward. */
function BriefStart({ plan, state }: { readonly plan: ReviewPlan; readonly state: ReviewState }): ReactElement {
  const path = pathProgress(plan, state)
  const resumeAt = nextUnreviewedStop(plan, state)
  const started = path.reviewed > 0
  return (
    <section className="guide-start" aria-label="Start the review">
      <div className="guide-effort">
        <p className="guide-effort-title">
          {started ? `You've reviewed ${path.reviewed} of ${path.total} on the path` : plan.stops.length === 0 ? "No changes need close attention" : `${plan.stops.length} ${plan.stops.length === 1 ? "change needs" : "changes need"} your attention`}
        </p>
        <p className="guide-note">
          {plan.lowerPriorityTotal > 0 && `${plan.lowerPriorityTotal} more ${plan.lowerPriorityTotal === 1 ? "is" : "are"} lower priority. `}
          {plan.stops.length === 0 && plan.lowerPriorityTotal > 0 && "Nothing stands out, so see everything under All changes. "}
          {plan.sizeNote !== null && `${plan.sizeNote}. Consider splitting it.`}
        </p>
        {started && <ProgressBar progress={path} label="Progress on the path" />}
      </div>
      {plan.stops.length > 0 && (
        <a className="guide-button guide-button-primary" href={resumeAt === undefined ? FINISH_HASH : hashForStop(resumeAt)}>
          {resumeAt === undefined ? "See your review" : started ? "Continue review" : "Start review"}
        </a>
      )}
    </section>
  )
}

function BriefSidebar({ review, plan }: { readonly review: ReviewModel; readonly plan: ReviewPlan }): ReactElement {
  const { files, risk } = review
  const additions = files.reduce((sum, file) => sum + file.diff.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.diff.deletions, 0)
  return (
    <aside className="guide-sidebar" aria-label="This pull request at a glance">
      <dl className="guide-stats">
        <Stat label="To review" value={String(plan.stops.length)} />
        <Stat label="Lower priority" value={String(plan.lowerPriorityTotal)} />
        <Stat label="Files" value={String(files.length)} />
        <div className="guide-stat">
          <dt>Lines</dt>
          <dd>
            <span className="added">+{additions}</span> <span className="removed">−{deletions}</span>
          </dd>
        </div>
      </dl>
      <section className="guide-card">
        <h2 className="guide-card-title">
          Checks <a href={RISKS_HASH}>Details</a>
        </h2>
        <ChecksList risk={risk} />
      </section>
      <AiCard review={review} />
    </aside>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="guide-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function ChecksList({ risk }: { readonly risk: RiskAssessment }): ReactElement {
  return (
    <ul className="guide-check-summary">
      {summarizeChecks(risk).map((row) => (
        <li key={row.name} className={`check-${row.outcome}`}>
          <span>{row.name}</span>
          <span className="check-result">{row.outcome === CheckOutcome.Issues ? row.issues : row.outcome === CheckOutcome.Clean ? "✓" : "⚠"}</span>
        </li>
      ))}
    </ul>
  )
}

function BriefChecks({ plan }: { readonly plan: ReviewPlan }): ReactElement {
  return (
    <section aria-labelledby="guide-checks">
      <h2 id="guide-checks" className="guide-heading">
        Check {plan.checks.length === 1 ? "this" : `these ${plan.checks.length} things`}
      </h2>
      <ul className="guide-checks">
        {plan.checks.map((check) => (
          <li key={check.message} className={`guide-check guide-check-${check.severity}`}>
            {check.stopIndex === undefined ? <InlineCode text={check.message} /> : <a href={hashForStop(check.stopIndex)}><InlineCode text={check.message} /></a>}
          </li>
        ))}
      </ul>
      {plan.moreChecks > 0 && (
        <p className="guide-note">
          <a href="#risks">{plan.moreChecks} more</a> in the full list.
        </p>
      )}
    </section>
  )
}

/** Anything flagged that the path can't take a reviewer to, which they could otherwise miss. */
function OffPathWarning({ plan }: { readonly plan: ReviewPlan }): ReactElement | null {
  if (plan.findingsOffPath === 0) return null
  return (
    <p className="guide-updated">
      <strong>
        {plan.findingsOffPath} {plan.findingsOffPath === 1 ? "finding isn't" : "findings aren't"} on the path,
      </strong>{" "}
      usually because {plan.findingsOffPath === 1 ? "it's" : "they're"} in a test or skippable file. <a href={RISKS_HASH}>Read {plan.findingsOffPath === 1 ? "it" : "them"} under Risks</a>.
    </p>
  )
}

/** The rules behind the path, and what they leave out, so "lower priority" is never a mystery. */
function WhyThesePanel({ plan }: { readonly plan: ReviewPlan }): ReactElement {
  const left = plan.lowerPriority
  const leftOut = [
    plan.pastTheLimit > 0 && `${plan.pastTheLimit} past the path's length limit. They earned a place, but have no findings.`,
    left.otherCode > 0 && `${left.otherCode} other edits to existing code, with no signal above.`,
    left.newCode > 0 && `${left.newCode} new functions or types that nothing else uses yet.`,
    left.quiet > 0 && `${left.quiet} changes to formatting, comments, names or location only.`,
    left.testFiles > 0 && `${left.testFiles} test files.`,
    left.otherFiles > 0 && `${left.otherFiles} other files, such as docs or config.`,
  ].filter((line) => typeof line === "string")
  return (
    <details className="guide-explain">
      <summary>How Walkdiff chose what to highlight</summary>
      <p>A change goes on the path for any of these, and the order follows the same list:</p>
      <ol>
        {PATH_RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ol>
      {leftOut.length > 0 && (
        <>
          <p>Not on the path, but still under <a href={ALL_CHANGES_HASH}>All changes</a>:</p>
          <ul>
            {leftOut.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <p>
        <strong>What this can miss:</strong> these are signals, and Walkdiff doesn't understand what the code is for. A wrong calculation in code nothing else uses would rank low, so if you know a change is delicate, look at it under All changes.
      </p>
    </details>
  )
}

function AiCard({ review }: { readonly review: ReviewModel }): ReactElement | null {
  if (review.ai.status === AiReviewStatus.Unavailable) {
    return (
      <section className="guide-card">
        <h2 className="guide-card-title">AI review</h2>
        <p className="guide-note">It didn't run: {review.ai.reason}.</p>
      </section>
    )
  }
  const digest = digestAiReview(review.ai)
  if (digest === undefined) return null
  return (
    <section className="guide-card">
      <h2 className="guide-card-title">
        AI review <a href={AI_REVIEW_HASH}>Read</a>
      </h2>
      <p className="guide-note">
        {digest.mismatches.length} {digest.mismatches.length === 1 ? "difference" : "differences"} from the description, {digest.questions.length} {digest.questions.length === 1 ? "question" : "questions"} to answer.
      </p>
    </section>
  )
}

function AiNotes({ review, stop }: { readonly review: ReviewModel; readonly stop: ReviewStop }): ReactElement | null {
  const notes = aiNotesForStop(review.ai, stop)
  if (notes.length === 0) return null
  return (
    <section className="guide-section">
      <h2 className="guide-heading">AI asks about this</h2>
      <ul className="ai-notes">
        {notes.map((note) => (
          <li key={note.title}>
            <details>
              <summary>{note.title}</summary>
              <p>{note.detail}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ProgressBar({ progress, label }: { readonly progress: Progress; readonly label: string }): ReactElement {
  const percent = progress.total === 0 ? 0 : Math.round((progress.reviewed / progress.total) * PERCENT)
  return (
    <div className="guide-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.reviewed} aria-label={label}>
      <div className="guide-progress-bar" style={{ width: `${percent}%` }} />
    </div>
  )
}

interface ReviewRailProps {
  readonly review: ReviewModel
  readonly plan: ReviewPlan
  readonly state: ReviewState
  readonly currentIndex: number | undefined
}

/** The whole path at a glance: what's done, where you are, and a link to every stop. */
function ReviewRail({ review, plan, state, currentIndex }: ReviewRailProps): ReactElement {
  const path = pathProgress(plan, state)
  const overall = overallProgress(review.files, state)
  const done = path.total > 0 && path.reviewed === path.total
  return (
    <nav className="guide-rail" aria-label="Review path">
      <a className="guide-rail-brief" href={REVIEW_HASH}>
        ← Brief
      </a>
      <p className="guide-rail-title">{done ? "✓ Path complete" : `${path.reviewed} of ${path.total} reviewed`}</p>
      <ProgressBar progress={path} label="Progress on the review path" />
      <ol className="guide-rail-list">
        {plan.stops.map((stop, index) => (
          <RailItem key={stopItems(stop).map((item) => item.id).join()} stop={stop} index={index} state={state} current={index === currentIndex} />
        ))}
      </ol>
      <a className={currentIndex === undefined ? "guide-rail-finish guide-rail-finish-current" : "guide-rail-finish"} href={FINISH_HASH} aria-current={currentIndex === undefined ? "page" : undefined}>
        Finish
      </a>
      <div className="guide-rail-overall">
        <p>
          {overall.reviewed} of {overall.total} changes overall
        </p>
        <ProgressBar progress={overall} label="Progress across all changes" />
        <a href={ALL_CHANGES_HASH}>All changes</a>
      </div>
    </nav>
  )
}

function RailItem({ stop, index, state, current }: { readonly stop: ReviewStop; readonly index: number; readonly state: ReviewState; readonly current: boolean }): ReactElement {
  const items = stopItems(stop)
  const reviewed = isReviewed(items, state)
  const commented = items.some((item) => state.comments.has(item.id))
  const outdated = !reviewed && items.some((item) => state.reviewed.has(item.id))
  const classes = ["guide-rail-item", current ? "guide-rail-item-current" : "", reviewed ? "guide-rail-item-done" : "", outdated ? "guide-rail-item-outdated" : ""].filter((name) => name !== "").join(" ")
  return (
    <li>
      <a className={classes} href={hashForStop(index)} aria-current={current ? "step" : undefined}>
        <span className="guide-rail-mark" aria-label={reviewed ? "Reviewed" : outdated ? "Changed since your review" : "Not reviewed"}>
          {reviewed ? "✓" : outdated ? "↻" : index + 1}
        </span>
        <span className="guide-rail-text">
          <span className="guide-rail-name">{stop.unit === null ? stop.file.diff.path.split("/").at(-1) : stop.title}</span>
          <span className="guide-rail-path">{stop.file.diff.path}</span>
        </span>
        <OpenCommentCount stop={stop} />
        {commented && <span className="guide-rail-comment" title="You left a comment here">Comment</span>}
      </a>
    </li>
  )
}

/** Discussion still open on this change, so a reviewer knows where others have weighed in. */
function OpenCommentCount({ stop }: { readonly stop: ReviewStop }): ReactElement | null {
  const load = useConversation()
  if (load.status !== "loaded") return null
  const count = openCommentsOnStop(load.conversation.threads, stop)
  if (count === 0) return null
  const label = count === 1 ? "1 comment in open threads on the PR" : `${count} comments in open threads on the PR`
  return (
    <span className="guide-rail-discussion" title={label} aria-label={label}>
      <span aria-hidden="true">💬</span> {count}
    </span>
  )
}

function StopView({ review, stop, index, total }: { readonly review: ReviewModel; readonly stop: ReviewStop; readonly index: number; readonly total: number }): ReactElement {
  const { state, setReviewed } = useReviewState()
  const items = stopItems(stop)
  const reviewed = isReviewed(items, state)
  const nextHash = index + 1 < total ? hashForStop(index + 1) : FINISH_HASH
  const previousHash = index > 0 ? hashForStop(index - 1) : REVIEW_HASH
  // A finding about the whole file is already explained under "Why it's here".
  const located = stop.findings.filter((finding) => finding.location?.line !== null)
  const markAndContinue = (): void => {
    setReviewed(items, true)
    window.location.hash = nextHash
  }
  return (
    <main className="guide-stop">
      <h1 className="guide-stop-title">
        <span className="guide-stop-number">{index + 1}</span> <code>{stop.title}</code> <span className="guide-stop-kind">{changeSummary(stop)}</span>
      </h1>
      {stop.unit !== null && <p className="guide-path">{stop.file.diff.path}</p>}

      <div className="guide-why">
        <p className="guide-why-title">Why it's here</p>
        {stop.reasons.length === 0 ? (
          <p>{stop.unit?.change.kind === UnitChangeKind.Added ? "It's new code, included so the path has somewhere to start. Nothing specific stands out." : "It changes existing code, though nothing specific stands out."}</p>
        ) : (
          <ul>
            {stop.reasons.map((reason) => (
              <li key={reason}>
                <InlineCode text={reason} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {stop.unit !== null && stop.unit.facts !== null && (
        <ul className="guide-facts" aria-label="What changed">
          {factPhrases(stop.unit.facts).map((phrase) => (
            <li key={phrase}>{phrase}</li>
          ))}
        </ul>
      )}

      <LineCommentScopeProvider file={stop.file}>
        <StopCode stop={stop} />
        <LineCommentPanel file={stop.file} />
      </LineCommentScopeProvider>

      <AiNotes review={review} stop={stop} />

      {located.length > 0 && (
        <section className="guide-section">
          <h2 className="guide-heading">Findings</h2>
          <RiskList findings={located} pullRequest={review.pullRequest} onOpenFile={undefined} />
        </section>
      )}
      <StopThreads stop={stop} files={review.files} />
      {stop.unit !== null && <Callers unit={stop.unit} review={review} />}
      {stop.unit !== null && <TestEvidence stop={stop} source={review.testCoverage?.source} />}

      <div className="guide-section">
        <ReviewControls key={items.map((item) => item.id).join()} items={items} commentId={items.at(0)?.id} />
      </div>

      <nav className="guide-nav" aria-label="Move through the path">
        <a className="guide-button" href={previousHash}>
          Back
        </a>
        <div className="guide-nav-forward">
          {!reviewed && (
            <a className="guide-button" href={nextHash}>
              Skip for now
            </a>
          )}
          {reviewed ? (
            <a className="guide-button guide-button-primary" href={nextHash}>
              {index + 1 < total ? "Next" : "Finish"}
            </a>
          ) : (
            <button type="button" className="guide-button guide-button-primary" onClick={markAndContinue}>
              {index + 1 < total ? "Reviewed, next" : "Reviewed, finish"}
            </button>
          )}
        </div>
      </nav>
      <p className="guide-keys">
        <kbd>{NEXT_KEY}</kbd> next · <kbd>{PREVIOUS_KEY}</kbd> back · <kbd>{MARK_KEY}</kbd> mark as reviewed
      </p>
    </main>
  )
}

/** After a new push, the difference from the version the reviewer saw comes first. */
function StopCode({ stop }: { readonly stop: ReviewStop }): ReactElement {
  const { stateAtOpen } = useReviewState()
  if (stop.unit === null) return <HunkView diff={stop.file.diff} />
  const item = stopItems(stop).at(0)
  const earlier = item === undefined ? undefined : stateAtOpen.reviewed.get(item.id)
  const isOutdated = item !== undefined && earlier !== undefined && earlier.fingerprint !== item.fingerprint
  if (!isOutdated || earlier.snapshot === null || item.snapshot === null) return <UnitBody path={stop.file.diff.path} unit={stop.unit} />
  return (
    <>
      <p className="guide-since">Since you reviewed it</p>
      <WithoutLineComments>
        <SideBySide path={stop.file.diff.path} before={earlier.snapshot} after={item.snapshot} numbered={!earlier.snapshot.elidesNestedUnits && !item.snapshot.elidesNestedUnits} />
      </WithoutLineComments>
      <details className="guide-section guide-details">
        <summary>The whole change in this PR</summary>
        <UnitBody path={stop.file.diff.path} unit={stop.unit} />
      </details>
    </>
  )
}

function Callers({ unit, review }: { readonly unit: ChangedUnit; readonly review: ReviewModel }): ReactElement | null {
  const impact = unit.impact
  if (impact === null) return null
  if (impact.status === UnitImpactStatus.Traced && impact.totalReferences === 0) return null
  const summary = impact.status === UnitImpactStatus.Traced ? `Used in ${impact.totalReferences} ${impact.totalReferences === 1 ? "place" : "places"}` : "Callers weren't traced"
  return (
    <details className="guide-section guide-details">
      <summary>{summary}</summary>
      <ImpactPanel unit={unit} impact={impact} pullRequest={review.pullRequest} />
    </details>
  )
}

/** What's known about whether this change is tested, strongest evidence first. */
function TestEvidence({ stop, source }: { readonly stop: ReviewStop; readonly source: string | undefined }): ReactElement {
  return (
    <section className="guide-section guide-evidence">
      <h2 className="guide-heading">Test evidence</h2>
      {stop.coverage?.kind === StopCoverageKind.Lines && <CoverageLine coverage={stop.coverage} source={source} />}
      {stop.coverage?.kind === StopCoverageKind.FileNotInReport && (
        <p className="guide-coverage guide-coverage-gap">
          <strong>Its file isn't in the coverage report.</strong> Most tools list only the files tests load, so no test may have loaded it. Or {source ?? "the report"} covers only part of the code.
        </p>
      )}
      {stop.coverage === null && source !== undefined && <p>{source} has no line data for this change.</p>}
      {stop.relatedTests.length === 0 ? (
        <p>No changed test mentions this. That doesn't mean it's untested.</p>
      ) : (
        <p>
          Changed tests that mention it:{" "}
          {stop.relatedTests.map((test, index) => (
            <span key={test}>
              {index > 0 && ", "}
              <code>{test}</code>
            </span>
          ))}
          . This is a hint, not proof that it's tested.
        </p>
      )}
    </section>
  )
}

function CoverageLine({ coverage, source }: { readonly coverage: LineCoverage; readonly source: string | undefined }): ReactElement {
  const covered = coverage.coveredLines.length
  const total = covered + coverage.uncoveredLines.length
  const lines = coverage.uncoveredLines.length > MAX_UNCOVERED_LINES_NAMED ? `${coverage.uncoveredLines.slice(0, MAX_UNCOVERED_LINES_NAMED).join(", ")} and ${coverage.uncoveredLines.length - MAX_UNCOVERED_LINES_NAMED} more` : coverage.uncoveredLines.join(", ")
  return (
    <p className={covered === total ? "guide-coverage guide-coverage-full" : "guide-coverage guide-coverage-gap"}>
      <strong>
        {covered} of {total} changed {total === 1 ? "line" : "lines"} ran in tests.
      </strong>{" "}
      {covered < total && `Didn't run: ${coverage.uncoveredLines.length === 1 ? "line" : "lines"} ${lines}. `}
      <span className="guide-note">From {source}. Running a line doesn't prove its behaviour was checked.</span>
    </p>
  )
}

function Finish({ review, plan, state }: { readonly review: ReviewModel; readonly plan: ReviewPlan; readonly state: ReviewState }): ReactElement {
  const path = pathProgress(plan, state)
  const overall = overallProgress(review.files, state)
  const pathDone = path.total > 0 && path.reviewed === path.total
  const allDone = overall.total > 0 && overall.reviewed === overall.total
  const remaining = describeRemaining(remainingOffPath(review.files, plan, state))
  const comments = commentsOnItems(review.files, state)
  const lineComments = lineCommentsIn(state.comments, review.files)
  const resumeAt = nextUnreviewedStop(plan, state)
  return (
    <main className="guide-stop guide-finish">
      <h1 className="guide-title">{finishTitle(allDone, pathDone, path)}</h1>
      <p className="guide-lede">
        {overall.reviewed} of {overall.total} changes reviewed overall. The decision is yours: Walkdiff only points at what to look at.
      </p>

      {isConnectedToApp() ? (
        <SubmitReviewForm review={review} comments={comments} lineComments={lineComments} />
      ) : (
        comments.length + lineComments.length > 0 && <Comments comments={comments} lineComments={lineComments} />
      )}

      {remaining.length > 0 && (
        <section className="guide-panel">
          <h2 className="guide-heading">Not reviewed yet</h2>
          <ul className="guide-plain-list">
            {remaining.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="guide-note">
            <a href={ALL_CHANGES_HASH}>Review these in All changes</a>
          </p>
        </section>
      )}

      <NotCheckedWarning checks={review.risk.notChecked} />

      <div className="guide-start">
        {resumeAt !== undefined && (
          <a className="guide-button" href={hashForStop(resumeAt)}>
            Continue the path
          </a>
        )}
        <a className="guide-button guide-button-primary" href={review.pullRequest.url} target="_blank" rel="noreferrer">
          Open the PR to respond
        </a>
      </div>
    </main>
  )
}

function finishTitle(allDone: boolean, pathDone: boolean, path: Progress): string {
  if (allDone) return "You've reviewed every change"
  if (path.total === 0) return "Nothing here needed a close look"
  return pathDone ? "You've finished the review path" : `${path.reviewed} of ${path.total} reviewed on the path`
}

/** A check that didn't run is a gap in what the reviewer can rely on, so it must not look routine. */
function NotCheckedWarning({ checks }: { readonly checks: readonly SkippedCheck[] }): ReactElement | null {
  if (checks.length === 0) return null
  return (
    <section className="guide-warning" aria-labelledby="guide-not-checked">
      <h2 id="guide-not-checked" className="guide-warning-title">
        <span aria-hidden="true">⚠</span> {checks.length === 1 ? "1 check didn't run" : `${checks.length} checks didn't run`}
      </h2>
      <p className="guide-warning-lede">Walkdiff can't tell you anything about these, so a clean result here doesn't cover them.</p>
      <ul className="guide-warning-list">
        {checks.map(({ check, reason }) => (
          <li key={check}>
            <strong>{check}</strong>
            <span className="guide-warning-reason"><InlineCode text={reason} /></span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Reasons mark commands with backticks, as Markdown does. */
function Comments({ comments, lineComments }: { readonly comments: readonly ItemComment[]; readonly lineComments: readonly LineComment[] }): ReactElement {
  const [copyResult, setCopyResult] = useState<CopyResult>(CopyResult.None)
  const markdown = commentsAsMarkdown(comments, lineComments)
  const count = comments.length + lineComments.length
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyResult(CopyResult.Copied)
      setTimeout(() => setCopyResult(CopyResult.None), COPY_CONFIRMATION_MS)
    } catch {
      // Browsers can refuse clipboard access, as on a report opened from disk.
      setCopyResult(CopyResult.Failed)
    }
  }
  return (
    <section className="guide-panel">
      <h2 className="guide-heading">
        Your {count === 1 ? "comment" : `${count} comments`}
      </h2>
      <CommentList comments={comments} lineComments={lineComments} />
      <button type="button" className="guide-button" onClick={() => void copy()}>
        {copyResult === CopyResult.Copied ? "Copied" : "Copy comments for the PR"}
      </button>
      {copyResult === CopyResult.Failed && <p className="guide-note">Your browser blocked copying. Select the comments above and copy them instead.</p>}
    </section>
  )
}

function describeRemaining(counts: RemainingCounts): string[] {
  const line = (count: number, one: string, many: string): string[] => (count === 0 ? [] : [`${count} ${count === 1 ? one : many}`])
  return [
    ...line(counts[ItemKind.ChangedCode], "other code change", "other code changes"),
    ...line(counts[ItemKind.NewCode], "new function or type", "new functions or types"),
    ...line(counts[ItemKind.Test], "test change", "test changes"),
    ...line(counts[ItemKind.File], "other file, such as docs or config", "other files, such as docs or config"),
  ]
}

function useKeyboardShortcuts(route: GuideRoute, plan: ReviewPlan, toggleReviewed: (() => void) | undefined): void {
  const total = plan.stops.length
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (route.kind === GuideRouteKind.Stop) {
        if (event.key === NEXT_KEY) window.location.hash = route.index + 1 < total ? hashForStop(route.index + 1) : FINISH_HASH
        if (event.key === PREVIOUS_KEY) window.location.hash = route.index > 0 ? hashForStop(route.index - 1) : REVIEW_HASH
        if (event.key === MARK_KEY) toggleReviewed?.()
      } else if (route.kind === GuideRouteKind.Brief && event.key === NEXT_KEY && total > 0) {
        window.location.hash = hashForStop(0)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [route, total, toggleReviewed])
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
}
