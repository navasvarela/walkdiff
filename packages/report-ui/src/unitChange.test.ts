import { describe, expect, it } from "vitest"
import { UnitChangeKind } from "@walkdiff/review-model"
import type { UnitChange } from "@walkdiff/review-model"
import { changeLabel, Tone } from "./unitChange.ts"

const SNAPSHOT = { startLine: 1, endLine: 2, text: "body", elidesNestedUnits: false }
const FROM = { path: "src/old.ts", qualifiedName: "load" }

describe("changeLabel for moves", () => {
  it.each<{ readonly name: string; readonly change: UnitChange; readonly text: string; readonly tone: Tone }>([
    { name: "an unedited move", change: { kind: UnitChangeKind.MovedIn, from: FROM, edited: false, before: SNAPSHOT, after: SNAPSHOT }, text: "Moved from src/old.ts", tone: Tone.Quiet },
    { name: "an edited move", change: { kind: UnitChangeKind.MovedIn, from: FROM, edited: true, before: SNAPSHOT, after: SNAPSHOT }, text: "Moved from src/old.ts and edited", tone: Tone.Modified },
  ])("labels $name", ({ change, text, tone }) => {
    expect(changeLabel(change)).toEqual({ text, tone })
  })
})
