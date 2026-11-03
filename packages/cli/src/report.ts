import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { firstExisting } from "@walkdiff/engine"
import type { ReviewModel } from "@walkdiff/review-model"

export const REVIEW_MODEL_FILE = "review.json"
export const REPORT_PAGE_FILE = "index.html"

// Next to the bundle in the npm package, and in the workspace when running from source.
const REPORT_UI_DIST = firstExisting([resolve(import.meta.dirname, "report-ui"), resolve(import.meta.dirname, "../../report-ui/dist")])
const SCRIPT_TAG = /<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/
const STYLESHEET_TAG = /<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/
const HEAD_END = "</head>"
/**
 * Travels with the file, so a report opened from disk or a CI artifact cannot contact anything,
 * even if a crafted PR got script onto the page. Servers add their own policy as a header. The
 * app removes this tag and allows calling itself and nothing else, because browsers apply every
 * policy on a page, and this one would stop a report from posting a review.
 */
const FILE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

export const REPORT_FILE_POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${FILE_POLICY}">`

export class ReportUiMissingError extends Error {
  override readonly name = "ReportUiMissingError"

  constructor() {
    super(`The report UI has not been built (expected ${REPORT_UI_DIST}). Run: pnpm build:ui`)
  }
}

export class ReportUiFormatError extends Error {
  override readonly name = "ReportUiFormatError"
}

/**
 * Writes the report as one self-contained page, plus the review model as data for tools.
 * Everything is inlined because a CI artifact is opened from disk, where browsers block
 * module scripts and `fetch` on file:// URLs.
 */
export async function writeReport(model: ReviewModel, reportDir: string): Promise<void> {
  const pagePath = join(REPORT_UI_DIST, REPORT_PAGE_FILE)
  if (!(await isReadable(pagePath))) {
    throw new ReportUiMissingError()
  }
  const page = await readFile(pagePath, "utf8")
  const assets = new Map(
    await Promise.all(
      assetPaths(page).map(async (path): Promise<[string, string]> => [path, await readFile(join(REPORT_UI_DIST, path), "utf8")]),
    ),
  )
  await mkdir(reportDir, { recursive: true })
  await writeFile(join(reportDir, REPORT_PAGE_FILE), assembleReportPage(page, assets, JSON.stringify(model)))
  await writeFile(join(reportDir, REVIEW_MODEL_FILE), JSON.stringify(model))
}

function assetPaths(page: string): string[] {
  return [SCRIPT_TAG.exec(page)?.[1], STYLESHEET_TAG.exec(page)?.[1]].filter((path): path is string => path !== undefined)
}

/** Replaces the page's script and stylesheet links with their contents and embeds the model. */
export function assembleReportPage(page: string, assets: ReadonlyMap<string, string>, modelJson: string): string {
  const asset = (path: string): string => {
    const content = assets.get(path)
    if (content === undefined) throw new ReportUiFormatError(`The report UI references a missing asset: ${path}`)
    return content
  }
  if (!SCRIPT_TAG.test(page) || !STYLESHEET_TAG.test(page) || !page.includes(HEAD_END)) {
    throw new ReportUiFormatError("The report UI page does not have the expected script and stylesheet tags")
  }
  // Replacer functions, because assets contain `$` sequences that string replacement would interpret.
  const inlined = page
    .replace(SCRIPT_TAG, (_tag, path: string) => `<script type="module">${asset(path).replaceAll("</script", "<\\/script")}</script>`)
    .replace(STYLESHEET_TAG, (_tag, path: string) => `<style>${asset(path).replaceAll("</style", "<\\/style")}</style>`)
  // `<` is escaped so text from the PR, such as "</script>" in code, cannot end the block.
  const embedded = `<script type="application/json" id="review-model">${modelJson.replaceAll("<", "\\u003c")}</script>`
  return inlined.replace(HEAD_END, () => `${REPORT_FILE_POLICY_TAG}\n${embedded}\n${HEAD_END}`)
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
