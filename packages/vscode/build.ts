import { writeFile } from "node:fs/promises"
import { build } from "rolldown"
import { builtReportPage } from "../cli/src/report.ts"
import { REPORT_MODEL_PLACEHOLDER, REPORT_TEMPLATE_FILE } from "./src/reportTemplate.ts"

/**
 * Bundles the extension into one CommonJS file, with Walkdiff's review model and zod inside it, so
 * the packaged extension needs no node_modules. `vscode` is provided by the editor at runtime.
 *
 * It also writes the report panel's page: the built report UI, the same page the app serves, with a
 * placeholder the panel fills with the review. Run `pnpm build:ui` first.
 */
await build({
  input: "src/extension.ts",
  external: ["vscode"],
  platform: "node",
  output: { file: "dist/extension.cjs", format: "cjs", sourcemap: true },
})
await writeFile(`dist/${REPORT_TEMPLATE_FILE}`, await builtReportPage(JSON.stringify(REPORT_MODEL_PLACEHOLDER)))
