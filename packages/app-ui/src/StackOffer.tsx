import { Fragment, useState } from "react"
import type { ReactElement } from "react"
import type { AiDestination, ReviewSummary, StackMember, StackOffer } from "@walkdiff/review-model"
import { aiOptionLabel } from "./aiChoice.ts"
import { memberName, newToList, siblingUrl } from "./stackList.ts"

interface StackOfferBannerProps {
  readonly review: ReviewSummary
  readonly offer: StackOffer
  readonly reviews: readonly ReviewSummary[]
  readonly destination: AiDestination | undefined
  readonly onAccept: (ai: boolean) => void
  readonly onDismiss: () => void
}

/**
 * Offers the rest of a stack found from this review. The AI box is spelled out again, starting
 * from this review's choice, because it decides whether the new members' code leaves the machine.
 */
export function StackOfferBanner({ review, offer, reviews, destination, onAccept, onDismiss }: StackOfferBannerProps): ReactElement {
  const [ai, setAi] = useState(review.ai)
  const grouped = review.stack !== null
  const adding = newToList(offer, review, reviews).length
  const joining = offer.joining.length
  return (
    <section className="stack-offer" aria-label="Stack found">
      <p>
        <strong>{grouped ? `${joining} new ${joining === 1 ? "PR" : "PRs"} joined this stack` : `Part of a stack of ${offer.members.length}`}</strong> into <code>{offer.trunk}</code>: <StackChain review={review} members={offer.members} />
      </p>
      {offer.leftOut.length > 0 && <LeftOut review={review} offer={offer} />}
      {adding > 0 ? (
        <label className="add-option">
          <input type="checkbox" checked={ai} onChange={(event) => setAi(event.target.checked)} />
          {aiOptionLabel(destination)}, for the {adding === 1 ? "PR" : `${adding} PRs`} not on your list yet
        </label>
      ) : (
        <p className="stack-offer-note">{joining === 1 ? "It's" : "They're all"} on your list already, and will be grouped without analyzing again.</p>
      )}
      <div className="review-actions">
        <button type="button" onClick={() => onAccept(ai)}>
          {grouped ? "Add to the stack" : "Review the whole stack"}
        </button>
        <button type="button" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </section>
  )
}

function StackChain({ review, members }: { readonly review: ReviewSummary; readonly members: readonly StackMember[] }): ReactElement {
  return (
    <>
      {members.map((member, index) => (
        <Fragment key={member.number}>
          {index > 0 && " → "}
          {member.number === review.number ? (
            <strong>{memberName(review, member)} (this one)</strong>
          ) : (
            <a href={siblingUrl(review, member.number)} target="_blank" rel="noreferrer">
              {memberName(review, member)}
            </a>
          )}
        </Fragment>
      ))}
    </>
  )
}

/** PRs side by side on the top member fork the chain, so they aren't part of it; they're named so the reviewer knows. */
function LeftOut({ review, offer }: { readonly review: ReviewSummary; readonly offer: StackOffer }): ReactElement | null {
  const top = offer.members.at(-1)
  if (top === undefined) return null
  return (
    <p className="stack-offer-note">
      {offer.leftOut.map((member, index) => (
        <Fragment key={member.number}>
          {index > 0 && (index === offer.leftOut.length - 1 ? " and " : ", ")}
          <a href={siblingUrl(review, member.number)} target="_blank" rel="noreferrer">
            {memberName(review, member)}
          </a>
        </Fragment>
      ))}{" "}
      also build on {memberName(review, top)}. Add them on their own if you want to review them.
    </p>
  )
}
