import { LogLevel } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { createLog, LogFormat } from "./logging.ts"

const NOW = new Date("2026-11-13T09:30:00.000Z")

function written(format: LogFormat): { readonly lines: string[]; readonly log: ReturnType<typeof createLog> } {
  const lines: string[] = []
  return { lines, log: createLog(format, { write: (line) => lines.push(line), now: () => NOW }) }
}

describe("createLog", () => {
  it("prints only the message as text, whatever its level and fields", () => {
    const { lines, log } = written(LogFormat.Text)
    log("Fetching the pull request…", { fields: { step: "fetchingPullRequest" } })
    log("Walkdiff couldn't install gitleaks.", { level: LogLevel.Warn })
    expect(lines).toEqual(["Fetching the pull request…", "Walkdiff couldn't install gitleaks."])
  })

  it("prints one JSON object per line with time, level, msg and the fields", () => {
    const { lines, log } = written(LogFormat.Json)
    log("Report written to out", { fields: { files: 3, reportDir: "out" } })
    log("Downloading failed. Trying again.", { level: LogLevel.Warn, fields: { url: "https://example.com/a" } })
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { time: "2026-11-13T09:30:00.000Z", level: "info", msg: "Report written to out", files: 3, reportDir: "out" },
      { time: "2026-11-13T09:30:00.000Z", level: "warn", msg: "Downloading failed. Trying again.", url: "https://example.com/a" },
    ])
  })

  it("keeps a field from replacing time, level or msg", () => {
    const { lines, log } = written(LogFormat.Json)
    log("Real message", { fields: { msg: "forged", level: "error", time: "0", review: "#4" } })
    expect(JSON.parse(lines[0] ?? "")).toEqual({ time: "2026-11-13T09:30:00.000Z", level: "info", msg: "Real message", review: "#4" })
  })

  it("escapes a message that holds a line break, so each event stays on one line", () => {
    const { lines, log } = written(LogFormat.Json)
    log("first\nsecond")
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("\n")
  })
})
