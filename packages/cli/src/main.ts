#!/usr/bin/env node
import { installScannersHere, MANAGED_SCANNERS_ROOT } from "@walkdiff/engine"
import { LogLevel, stepLabel } from "@walkdiff/review-model"
import type { Log } from "@walkdiff/review-model"
import { runApp } from "./appCommand.ts"
import { logFormatFromEnvironment, parseCommandLine, USAGE, UsageError } from "./args.ts"
import { defaultCacheDir, protectLocalData, readHostTokens } from "./environment.ts"
import { runComment } from "./commentCommand.ts"
import { createLog, LogFormat } from "./logging.ts"
import { runReview } from "./reviewCommand.ts"
import { walkdiffVersion } from "./version.ts"

const EXIT_FAILURE = 1
const EXIT_USAGE = 2

// Reports, cached repositories and the review list all hold private code or its details.
const OWNER_ONLY_UMASK = 0o077

async function main(argv: readonly string[], log: Log): Promise<void> {
  process.umask(OWNER_ONLY_UMASK)
  await protectLocalData(process.env)
  const { command } = parseCommandLine(argv, process.env)
  switch (command.kind) {
    case "help":
      console.log(USAGE)
      return
    case "version":
      console.log(`walkdiff ${walkdiffVersion()}`)
      return
    case "setup":
      await installScannersHere(log)
      log(`Scanners are ready in ${MANAGED_SCANNERS_ROOT}.`, { fields: { scannersDir: MANAGED_SCANNERS_ROOT } })
      return
    case "review":
      if (command.options.network) await installScannersHere(log)
      await runReview(command.options, {
        tokens: readHostTokens(process.env),
        cacheDir: command.options.cacheDir ?? defaultCacheDir(process.env),
        env: process.env,
        cwd: process.cwd(),
        now: () => new Date(),
        log,
        reportStep: (step) => log(`${stepLabel(step)}…`, { fields: { step } }),
      })
      return
    case "app":
      if (command.options.network) await installScannersHere(log)
      await runApp(command.options, { env: process.env, now: () => new Date(), log })
      return
    case "comment":
      await runComment(command.options, {
        tokens: readHostTokens(process.env),
        stepSummaryPath: process.env.GITHUB_STEP_SUMMARY,
        log,
      })
      return
  }
}

// Logs go to stderr, which keeps stdout for what a command prints: its help or version.
const logFormat = chosenLogFormat(process.argv.slice(2), process.env)
const log = createLog(logFormat, { write: (line) => console.error(line), now: () => new Date() })

main(process.argv.slice(2), log).catch((error: unknown) => {
  if (error instanceof UsageError) {
    log(error.message, { level: LogLevel.Error })
    // A JSON log is read by tools, which have no use for the usage text.
    if (logFormat === LogFormat.Text) console.error(`\n${USAGE}`)
    process.exitCode = EXIT_USAGE
    return
  }
  const version = readableVersion()
  log(error instanceof Error ? `${error.name}: ${error.message}` : String(error), { level: LogLevel.Error, fields: { version: version ?? "unknown" } })
  if (logFormat === LogFormat.Text) console.error(version === undefined ? "(walkdiff, version unknown)" : `(walkdiff ${version})`)
  process.exitCode = EXIT_FAILURE
})

// An invalid command line is reported in the format asked for when that part can be read.
function chosenLogFormat(argv: readonly string[], env: NodeJS.ProcessEnv): LogFormat {
  try {
    return parseCommandLine(argv, env).logFormat
  } catch {
    return logFormatFromEnvironment(env)
  }
}

/** Every failure names the version, so a report of one says which Walkdiff it came from. */
function readableVersion(): string | undefined {
  // The failure itself must still be reported when the version can't be read.
  try {
    return walkdiffVersion()
  } catch {
    return undefined
  }
}
