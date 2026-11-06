import { repositoryPath } from "@walkdiff/providers"
import type { PullRequestRef } from "@walkdiff/providers"
import { GitHostKind } from "@walkdiff/review-model"
import type { PullRequestStack, StackOffer } from "@walkdiff/review-model"

/** One row per PR, however its URL was pasted (`/files`, trailing slash, and so on). */
export function canonicalUrl(ref: PullRequestRef): string {
  const path = ref.host === GitHostKind.GitHub ? "pull" : "-/merge_requests"
  return `${ref.webOrigin}/${repositoryPath(ref)}/${path}/${ref.number}`
}

/**
 * The URL of another PR in the same repository. Stack members are only ever reached this way,
 * so whatever a host answers, the app and its token stay on the repository being reviewed.
 */
export function memberUrl(reviewed: PullRequestRef, number: number): string {
  return canonicalUrl({ ...reviewed, number })
}

export interface OfferInput {
  readonly reviewed: PullRequestRef
  readonly detected: PullRequestStack
  /** The URLs of the reviews already grouped with this one, if it's in a stack. */
  readonly grouped: ReadonlySet<string>
  /** Members the reviewer said "Not now" to. */
  readonly dismissed: ReadonlySet<number>
}

/** What to offer for a detected stack: undefined when every member is grouped already or was turned down. */
export function stackOfferFor({ reviewed, detected, grouped, dismissed }: OfferInput): StackOffer | undefined {
  const reviewedUrl = canonicalUrl(reviewed)
  const joining = detected.members
    .map((member) => member.number)
    .filter((number) => !dismissed.has(number))
    .filter((number) => {
      const url = memberUrl(reviewed, number)
      return url !== reviewedUrl && !grouped.has(url)
    })
  return joining.length === 0 ? undefined : { ...detected, joining }
}

/**
 * Orders a stack after a new detection: the detected members in the host's order, with members
 * it no longer lists, such as a merged bottom PR, kept just before the member that followed them.
 */
export function mergedOrder(previous: readonly string[], detected: readonly string[]): string[] {
  const order = [...detected]
  const inDetected = new Set(detected)
  // Walking backwards means each kept member's successor is already placed when it is.
  for (let index = previous.length - 1; index >= 0; index--) {
    const url = previous[index]
    if (url === undefined || inDetected.has(url) || order.includes(url)) continue
    const next = previous.slice(index + 1).find((later) => order.includes(later))
    order.splice(next === undefined ? order.length : order.indexOf(next), 0, url)
  }
  return order
}
