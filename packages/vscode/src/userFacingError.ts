/** A failure whose message is written for the user, shown as it is. */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError"
}

/** The user backed out of a prompt, so there's nothing to show. */
export class CancelledError extends Error {
  override readonly name = "CancelledError"
}
