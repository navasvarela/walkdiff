import { isHostedPullRequest } from "@walkdiff/review-model"
import type { ReviewModel } from "@walkdiff/review-model"

/** What says whether a cached report is still current: the review's id and when it last changed. */
export interface ReviewVersion {
  readonly id: number
  readonly updatedAt: string
}

interface Cached {
  readonly updatedAt: string | undefined
  readonly report: Promise<ReviewModel>
}

/**
 * Reports read from the app, kept until their review changes. The reviews view, commenting and
 * submitting all ask for the same reports, and each can be a few megabytes.
 */
export class ReportCache {
  readonly #load: (id: number) => Promise<ReviewModel>
  readonly #reports = new Map<number, Cached>()

  constructor(load: (id: number) => Promise<ReviewModel>) {
    this.#load = load
  }

  /** The report for this version of the review, read again when the review has changed since. */
  current(review: ReviewVersion): Promise<ReviewModel> {
    const cached = this.#reports.get(review.id)
    return cached?.updatedAt === review.updatedAt ? cached.report : this.#read(review.id, review.updatedAt)
  }

  /** The report last read for a review, or a fresh one when there's none, for when only the id is known. */
  latest(id: number): Promise<ReviewModel> {
    return this.#reports.get(id)?.report ?? this.#read(id, undefined)
  }

  #read(id: number, updatedAt: string | undefined): Promise<ReviewModel> {
    const report = this.#load(id)
    this.#reports.set(id, { updatedAt, report })
    // A failed read isn't kept, so the next request tries again. The caller still gets the failure.
    report.catch(() => {
      if (this.#reports.get(id)?.report === report) this.#reports.delete(id)
    })
    return report
  }
}

/** The key a review's drafts are kept under: its PR's link, which outlives the review's id in the app. */
export function draftKeyOf(report: ReviewModel, reviewId: number): string {
  return isHostedPullRequest(report.pullRequest) ? report.pullRequest.url : `local:${reviewId}`
}
