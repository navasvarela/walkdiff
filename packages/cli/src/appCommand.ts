import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { findInstalledScanners } from "@walkdiff/engine"
import { gitHostFor } from "@walkdiff/providers"
import type { AppOptions } from "./args.ts"
import { startAppServer } from "./app/appServer.ts"
import { ReviewService } from "./app/reviewService.ts"
import { ReviewStore } from "./app/reviewStore.ts"
import { defaultCacheDir, defaultDataDir, hostTokensFor, runCommand } from "./environment.ts"
import { canOpenBrowser, openBrowser } from "./openBrowser.ts"
import { writeReport } from "./report.ts"
import { analyzePullRequest, defaultReportDir } from "./reviewCommand.ts"

const DATABASE_FILE = "walkdiff.db"

export interface AppDependencies {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly now: () => Date
  readonly log: (message: string) => void
}

/** Runs the local app until the process is stopped. */
export async function runApp(options: AppOptions, deps: AppDependencies): Promise<void> {
  const cacheDir = options.cacheDir ?? defaultCacheDir(deps.env)
  const dataDir = options.dataDir ?? defaultDataDir(deps.env)
  await mkdir(dataDir, { recursive: true })

  const store = new ReviewStore(join(dataDir, DATABASE_FILE), deps.now)
  store.markInterrupted()
  const service = new ReviewService(
    store,
    async ({ ref, ai, attachedCoverage, reportStep }) => {
      const settings = store.getSettings()
      const model = await analyzePullRequest(
        ref,
        { network: options.network, coveragePath: undefined, attachedCoverage, ai: ai ? settings.ai : undefined, disabledChecks: settings.disabledChecks },
        // Looked up per PR, so a token is only ever asked for the host it belongs to.
        { tokens: await hostTokensFor(ref, deps.env, runCommand), cacheDir, now: deps.now, log: deps.log, reportStep },
      )
      const reportDir = defaultReportDir(cacheDir, ref)
      await writeReport(model, reportDir)
      return { model, reportDir }
    },
    deps.log,
  )
  const server = await startAppServer(store, service, { port: options.port, log: deps.log, env: deps.env, offline: !options.network, hostFor: async (ref) => gitHostFor(ref, await hostTokensFor(ref, deps.env, runCommand)) })
  deps.log(`Walkdiff is running at ${server.url} (Ctrl+C to stop)`)
  if (options.open && canOpenBrowser(process.platform, deps.env)) openBrowser(server.url, deps.log)
  const scanners = await findInstalledScanners()
  deps.log(`Security scanners: ${scanners.installed.join(", ") || "none"} installed${scanners.missing.length > 0 ? `; not found: ${scanners.missing.join(", ")}` : ""}`)
}
