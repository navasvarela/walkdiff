import { describe, expect, it } from "vitest"
import { REPORT_MODEL_PLACEHOLDER, reportPage, ReportTemplateError } from "./reportTemplate.ts"
import { testReport } from "./testReport.ts"

const TEMPLATE = `<html><head><title>r</title><script type="application/json" id="review-model">${JSON.stringify(REPORT_MODEL_PLACEHOLDER)}</script></head><body></body></html>`

describe("reportPage", () => {
  it("fills in the review, its id, the editor transport and the saved progress", () => {
    const page = reportPage(TEMPLATE, testReport(), 7, { "walkdiff-review:x": "{}" })
    const model = /id="review-model">([^<]*)<\/script>/.exec(page)?.[1] ?? ""
    expect(JSON.parse(model)).toMatchObject({ pullRequest: { number: 7 } })
    expect(page).toContain('<meta name="walkdiff-review-id" content="7">')
    expect(page).toContain('<meta name="walkdiff-transport" content="editor">')
    expect(page).toContain('<script type="application/json" id="walkdiff-saved-state">{"walkdiff-review:x":"{}"}</script>')
    expect(page).not.toContain(REPORT_MODEL_PLACEHOLDER)
  })

  it("keeps text from the PR from ending its script element", () => {
    const report = testReport()
    const page = reportPage(TEMPLATE, { ...report, pullRequest: { ...report.pullRequest, title: "</script><script>alert(1)</script>" } }, 1, { k: "</script>" })
    expect(page.match(/<\/script>/g)).toHaveLength(2)
  })

  it("refuses a page without the placeholder", () => {
    expect(() => reportPage("<html><head></head></html>", testReport(), 1, {})).toThrow(ReportTemplateError)
  })
})
