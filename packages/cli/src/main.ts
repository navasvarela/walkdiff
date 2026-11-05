#!/usr/bin/env node
import { installScannersHere, MANAGED_SCANNERS_ROOT } from "@walkdiff/engine"
import { stepLabel } from "@walkdiff/review-model"
import { runApp } from "./appCommand.ts"
import { parseCommand, USAGE, UsageError } from "./args.ts"
import { defaultCacheDir, protectLocalData, readHostTokens } from "./environment.ts"
import { runComment } from "./commentCommand.ts"
import { runReview } from "./reviewCommand.ts"

const EXIT_FAILURE = 1
const EXIT_USAGE = 2

// Reports, cached repositories and the review list all hold private code or its details.
const OWNER_ONLY_UMASK = 0o077

async function main(argv: readonly string[]): Promise<void> {
  process.umask(OWNER_ONLY_UMASK)
  await protectLocalData(process.env)
  const command = parseCommand(argv)
  switch (command.kind) {
    case "help":
      console.log(USAGE)
      return
    case "setup":
      await installScannersHere((message) => console.error(message))
      console.error(`Scanners are ready in ${MANAGED_SCANNERS_ROOT}.`)
      return
    case "review":
      if (command.options.network) await installScannersHere((message) => console.error(message))
      await runReview(command.options, {
        tokens: readHostTokens(process.env),
        cacheDir: command.options.cacheDir ?? defaultCacheDir(process.env),
        env: process.env,
        now: () => new Date(),
        log: (message) => console.error(message),
        reportStep: (step) => console.error(`${stepLabel(step)}…`),
      })
      return
    case "app":
      if (command.options.network) await installScannersHere((message) => console.error(message))
      await runApp(command.options, { env: process.env, now: () => new Date(), log: (message) => console.error(message) })
      return
    case "comment":
      await runComment(command.options, {
        tokens: readHostTokens(process.env),
        stepSummaryPath: process.env.GITHUB_STEP_SUMMARY,
        log: (message) => console.error(message),
      })
      return
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`)
    process.exitCode = EXIT_USAGE
    return
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = EXIT_FAILURE
})
