import { REPORT_SAVED_STATE_ELEMENT_ID, REPORT_TRANSPORT_META, ReportTransport } from "@walkdiff/review-model"
import type { ReviewModel } from "@walkdiff/review-model"

/** The report panel's page, next to the bundle, written by build.ts. */
export const REPORT_TEMPLATE_FILE = "report.html"
/** Stands in for the review model in the built page until a panel fills it in. */
export const REPORT_MODEL_PLACEHOLDER = "__WALKDIFF_REPORT_MODEL__"
const REVIEW_ID_META = "walkdiff-review-id"
const HEAD_END = "</head>"

/**
 * JSON for a script element. `<` is escaped so text from the PR, such as "</script>" in code,
 * can't end the element; the app's report pages embed their model the same way.
 */
function embeddable(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

export class ReportTemplateError extends Error {
  override readonly name = "ReportTemplateError"
}

/**
 * The report page for one review in an editor panel: the model in place of the placeholder, the
 * review's id, the editor transport, and the progress saved for it. The page carries no key: it
 * asks the extension to call the app.
 *
 * # Errors
 *
 * Throws a `ReportTemplateError` when the template isn't one build.ts wrote.
 */
export function reportPage(template: string, model: ReviewModel, reviewId: number, saved: Readonly<Record<string, string>>): string {
  const placeholder = JSON.stringify(REPORT_MODEL_PLACEHOLDER)
  if (!template.includes(placeholder) || !template.includes(HEAD_END)) throw new ReportTemplateError("The extension's report page is missing or damaged. Reinstall the extension.")
  const extras = `<meta name="${REVIEW_ID_META}" content="${reviewId}"><meta name="${REPORT_TRANSPORT_META}" content="${ReportTransport.Editor}"><script type="application/json" id="${REPORT_SAVED_STATE_ELEMENT_ID}">${embeddable(saved)}</script>`
  return template.replace(placeholder, () => embeddable(model)).replace(HEAD_END, () => `${extras}${HEAD_END}`)
}
