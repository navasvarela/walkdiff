-- The versions of the app's API and report format this plugin reads, as docs/app-api.md describes.
-- They follow the app's PLUGIN_API_VERSION and REVIEW_MODEL_SCHEMA_VERSION; a test in
-- packages/cli/src/app/editorPlugins.test.ts fails when either moves without this file.
return {
  api = 1,
  report_schema = 11,
}
