import type { ReactElement } from "react"
import { describeRange, lineCommentKey } from "../lineComments.ts"
import type { LineComment } from "../lineComments.ts"
import type { ItemComment } from "../reviewProgress.ts"

/** Every comment in the review, on whole changes and on picked lines. */
export function CommentList({ comments, lineComments }: { readonly comments: readonly ItemComment[]; readonly lineComments: readonly LineComment[] }): ReactElement {
  return (
    <ul className="guide-comment-list">
      {comments.map(({ item, text }) => (
        <li key={item.id}>
          <code>{item.label}</code>
          <p>{text}</p>
        </li>
      ))}
      {lineComments.map(({ path, range, text }) => (
        <li key={lineCommentKey(path, range)}>
          <code>{path}</code> {describeRange(range)}
          <p>{text}</p>
        </li>
      ))}
    </ul>
  )
}
