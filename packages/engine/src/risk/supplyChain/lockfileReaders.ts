import { basename } from "node:path"
import type { LockfileReader } from "./lockedPackage.ts"
import { PACKAGE_LOCK, PNPM_LOCK, YARN_LOCK } from "./npmLockfiles.ts"
import { CARGO_LOCK, GO_SUM, POETRY_LOCK, UV_LOCK } from "./otherLockfiles.ts"

const LOCKFILE_READERS: readonly LockfileReader[] = [PACKAGE_LOCK, YARN_LOCK, PNPM_LOCK, CARGO_LOCK, UV_LOCK, POETRY_LOCK, GO_SUM]

/** The reader for a lockfile at `path`, by its file name; undefined for anything else. */
export function lockfileReaderFor(path: string): LockfileReader | undefined {
  return LOCKFILE_READERS.find((reader) => reader.matches(basename(path)))
}
