import * as vscode from "vscode"
import { AppClient, AppGoneError } from "./appClient.ts"
import { connectionFilePath, readConnection } from "./connection.ts"
import { CancelledError, UserFacingError } from "./userFacingError.ts"

const TERMINAL_NAME = "Walkdiff app"
const START_CHOICE = "Start"
// The first `npx walkdiff` downloads the package and its parsers, which can take a minute or two.
const START_TIMEOUT_MS = 180_000
const START_POLL_MS = 500

/** The extension's link to the Walkdiff app, found from the connection file the app writes. */
export class AppSession {
  #client: AppClient | undefined

  /** The app's client if it's running, without asking to start it. */
  async existing(): Promise<AppClient | undefined> {
    if (this.#client !== undefined) return this.#client
    try {
      this.#client = await connect()
    } catch (error: unknown) {
      if (!(error instanceof AppGoneError)) throw error
    }
    return this.#client
  }

  /** The app's client, offering to start the app when it isn't running. */
  async client(): Promise<AppClient> {
    const running = await this.existing()
    if (running !== undefined) return running
    const choice = await vscode.window.showInformationMessage("Reviews run in the Walkdiff app, which isn't running. Start it?", START_CHOICE)
    if (choice !== START_CHOICE) throw new CancelledError()
    return this.start()
  }

  /** Starts the app in a terminal, where its output stays visible, and waits until it answers. */
  async start(): Promise<AppClient> {
    const running = await this.existing()
    if (running !== undefined) return running
    const command = vscode.workspace.getConfiguration("walkdiff").get<string>("command", "npx walkdiff")
    const terminal = vscode.window.terminals.find((open) => open.name === TERMINAL_NAME) ?? vscode.window.createTerminal({ name: TERMINAL_NAME })
    terminal.sendText(`${command} app --no-open`)
    terminal.show(true)
    this.#client = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Starting the Walkdiff app…", cancellable: true }, (_progress, cancel) => waitForApp(cancel))
    return this.#client
  }

  /** Drops the client after the app stopped, so the next call reads the connection file again. */
  forget(): void {
    this.#client = undefined
  }
}

/** A client for the app the connection file points at; undefined when there's no file. */
async function connect(): Promise<AppClient | undefined> {
  const dataDir = vscode.workspace.getConfiguration("walkdiff").get<string>("dataDir", "")
  const connection = await readConnection(connectionFilePath(dataDir, process.env))
  if (connection === undefined) return undefined
  const client = new AppClient(connection)
  // A file left behind by an app that crashed points at nothing; this throws AppGoneError then.
  await client.checkVersions()
  return client
}

async function waitForApp(cancel: vscode.CancellationToken): Promise<AppClient> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (cancel.isCancellationRequested) throw new CancelledError()
    try {
      const client = await connect()
      if (client !== undefined) return client
    } catch (error: unknown) {
      if (!(error instanceof AppGoneError)) throw error
    }
    await new Promise((done) => setTimeout(done, START_POLL_MS))
  }
  throw new UserFacingError(`The Walkdiff app didn't start. Its output is in the "${TERMINAL_NAME}" terminal.`)
}
