import type { UnitKind } from "@walkdiff/review-model"
import type { FileVersions } from "./compareUnits.ts"
import type { Definition } from "./definitions.ts"
import type { FunctionMetrics } from "./shape.ts"

/** A function at the head and how it measured before; undefined `before` means it is new. */
export interface FunctionQuality {
  readonly path: string
  /** A function or a method, told apart so test code can be recognised by name. */
  readonly kind: UnitKind
  readonly qualifiedName: string
  readonly line: number
  readonly before: FunctionMetrics | undefined
  readonly after: FunctionMetrics
}

/**
 * Measures every function at the head against its previous version. Reads definitions rather
 * than compared units because a new class is reported as one unit, which would hide its methods.
 * A function with no match by name is matched by body, so a rename or move does not count as new.
 */
export function functionQualities(files: readonly FileVersions[]): FunctionQuality[] {
  const beforeByBody = new Map(
    files.flatMap((file) => file.before?.definitions ?? []).flatMap((definition) => (definition.shape === undefined ? [] : [[definition.fingerprints.nameAgnosticCode, definition.shape.metrics] as const])),
  )
  return files.flatMap((file) => {
    const beforeByKey = new Map((file.before?.definitions ?? []).map((definition) => [definition.key, definition]))
    return (file.after?.definitions ?? []).flatMap((definition) => {
      if (definition.shape === undefined) return []
      return [{
        path: file.path,
        kind: definition.kind,
        qualifiedName: definition.qualifiedName,
        line: definition.snapshot.startLine,
        before: previousMetrics(definition, beforeByKey, beforeByBody),
        after: definition.shape.metrics,
      }]
    })
  })
}

function previousMetrics(
  definition: Definition,
  beforeByKey: ReadonlyMap<string, Definition>,
  beforeByBody: ReadonlyMap<string, FunctionMetrics>,
): FunctionMetrics | undefined {
  return beforeByKey.get(definition.key)?.shape?.metrics ?? beforeByBody.get(definition.fingerprints.nameAgnosticCode)
}
