import { build } from "rolldown"

/**
 * Bundles the extension into one CommonJS file, with Walkdiff's review model and zod inside it, so
 * the packaged extension needs no node_modules. `vscode` is provided by the editor at runtime.
 */
await build({
  input: "src/extension.ts",
  external: ["vscode"],
  platform: "node",
  output: { file: "dist/extension.cjs", format: "cjs", sourcemap: true },
})
