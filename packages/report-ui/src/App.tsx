import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import type { ReviewModel, UnitRef } from "@walkdiff/review-model"
import { AiReviewView } from "./components/AiReviewView.tsx"
import { ConversationView } from "./components/ConversationView.tsx"
import { FileList } from "./components/FileList.tsx"
import { FileView } from "./components/FileView.tsx"
import { ImpactView } from "./components/ImpactView.tsx"
import { TopBar, TopBarSection } from "./components/TopBar.tsx"
import { PullRequestHeader } from "./components/PullRequestHeader.tsx"
import { ReviewGuide } from "./components/ReviewGuide.tsx"
import { ReportTabs, tabButtonId, tabPanelId } from "./components/ReportTabs.tsx"
import { RiskView } from "./components/RiskView.tsx"
import { loadReview } from "./loadReview.ts"
import type { ReviewLoad } from "./loadReview.ts"
import { findingsInFile } from "./risks.ts"
import { ConversationProvider, useConversation } from "./conversationState.tsx"
import { guideRouteFromHash } from "./reviewPlan.ts"
import { ReviewStateProvider } from "./reviewState.tsx"
import { ReportTab, summarizeTabs, tabFromHash } from "./tabs.ts"

export function App(): ReactElement {
  const [load, setLoad] = useState<ReviewLoad>({ status: "loading" })

  useEffect(() => {
    void loadReview().then(setLoad)
  }, [])

  switch (load.status) {
    case "loading":
      return <p className="notice">Loading review…</p>
    case "failed":
      return <p className="notice notice-error">{load.message}</p>
    case "loaded":
      return <Routed review={load.review} />
  }
}

/** The guided review comes first; the full lists are one link away from it. */
function Routed({ review }: ReportProps): ReactElement {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const followHash = (): void => setHash(window.location.hash)
    window.addEventListener("hashchange", followHash)
    return () => window.removeEventListener("hashchange", followHash)
  }, [])
  const route = guideRouteFromHash(hash)
  return (
    <ReviewStateProvider review={review}>
      <ConversationProvider>{route === undefined ? <Report review={review} /> : <ReviewGuide review={review} route={route} />}</ConversationProvider>
    </ReviewStateProvider>
  )
}

interface ReportProps {
  readonly review: ReviewModel
}

function Report({ review }: ReportProps): ReactElement {
  const [tab, setTab] = useState<ReportTab>(tabFromHash(window.location.hash))
  const firstReviewable = review.files.find((file) => file.noise === null) ?? review.files.at(0)
  const [selectedPath, setSelectedPath] = useState(firstReviewable?.diff.path)
  const [impactFocus, setImpactFocus] = useState<UnitRef>()
  const selectedFile = review.files.find((file) => file.diff.path === selectedPath)

  // The hash is the source of truth for the tab, so the back button and shared links work.
  useEffect(() => {
    const followHash = (): void => setTab(tabFromHash(window.location.hash))
    window.addEventListener("hashchange", followHash)
    return () => window.removeEventListener("hashchange", followHash)
  }, [])

  // Browsers clear the scroll position of a hidden element, so it is kept here while on
  // another tab. Opening a different file starts at its top.
  const contentRef = useRef<HTMLElement>(null)
  const changesScrollTop = useRef(0)
  useLayoutEffect(() => {
    changesScrollTop.current = 0
    if (contentRef.current !== null) contentRef.current.scrollTop = 0
  }, [selectedPath])
  useLayoutEffect(() => {
    if (tab === ReportTab.Changes && contentRef.current !== null) contentRef.current.scrollTop = changesScrollTop.current
  }, [tab])
  const rememberScroll = (): void => {
    if (tab === ReportTab.Changes && contentRef.current !== null) changesScrollTop.current = contentRef.current.scrollTop
  }

  const conversation = useConversation()
  const openThreads = conversation.status === "loaded" ? conversation.conversation.threads.filter((thread) => !thread.isResolved).length : undefined

  const showTab = (next: ReportTab): void => {
    setTab(next)
    window.location.hash = next
  }
  const openFile = (path: string): void => {
    setSelectedPath(path)
    showTab(ReportTab.Changes)
  }
  const showImpact = (unit: UnitRef): void => {
    setImpactFocus(unit)
    showTab(ReportTab.Impact)
  }

  return (
    <div className="layout">
      <TopBar review={review} section={TopBarSection.AllChanges} />
      <PullRequestHeader pullRequest={review.pullRequest} files={review.files} risk={review.risk} feedbackUrl={review.feedbackUrl} />
      <ReportTabs tabs={summarizeTabs(review, openThreads)} selected={tab} onSelect={showTab} />
      {/* Stays mounted while hidden, so expanded cards and the scroll position survive a tab switch. */}
      <div id={tabPanelId(ReportTab.Changes)} role="tabpanel" aria-labelledby={tabButtonId(ReportTab.Changes)} className="changes-panel" hidden={tab !== ReportTab.Changes}>
        <FileList files={review.files} findings={review.risk.findings} selectedPath={selectedPath} onSelect={setSelectedPath} />
        <main ref={contentRef} className="content" onScroll={rememberScroll}>
          {selectedFile === undefined ? (
            <p className="notice">This pull request changes no files.</p>
          ) : (
            <FileView
              key={selectedFile.diff.path}
              file={selectedFile}
              findings={findingsInFile(review.risk.findings, selectedFile.diff.path)}
              pullRequest={review.pullRequest}
              onShowImpact={showImpact}
            />
          )}
        </main>
      </div>
      {tab !== ReportTab.Changes && (
        <div id={tabPanelId(tab)} role="tabpanel" aria-labelledby={tabButtonId(tab)} className="content tab-panel">
          {tab === ReportTab.Impact && <ImpactView files={review.files} focus={impactFocus} pullRequest={review.pullRequest} onOpenFile={openFile} />}
          {tab === ReportTab.Risks && <RiskView risk={review.risk} pullRequest={review.pullRequest} onOpenFile={openFile} />}
          {tab === ReportTab.Conversation && <ConversationView />}
          {tab === ReportTab.AiReview && <AiReviewView ai={review.ai} pullRequest={review.pullRequest} onOpenFile={openFile} />}
        </div>
      )}
    </div>
  )
}
