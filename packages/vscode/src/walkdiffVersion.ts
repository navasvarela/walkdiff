/** The first Walkdiff whose app writes the connection file this extension looks for. */
export const MIN_WALKDIFF_VERSION = "0.14.0"

type Version = readonly [number, number, number]

const VERSION_OUTPUT = /walkdiff (\d+)\.(\d+)\.(\d+)/

function parse(text: string): Version | undefined {
  const match = VERSION_OUTPUT.exec(text)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isOlder(a: Version, b: Version): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
}

/**
 * What to tell the user about the Walkdiff that `walkdiff --version` printed: why it can't serve
 * this extension, or undefined when it can or when the output doesn't say, such as from a wrapper
 * script, which is then left to try.
 */
export function versionProblem(versionOutput: string): string | undefined {
  const found = parse(versionOutput)
  const needed = parse(`walkdiff ${MIN_WALKDIFF_VERSION}`)
  if (found === undefined || needed === undefined || !isOlder(found, needed)) return undefined
  return `This extension needs Walkdiff ${MIN_WALKDIFF_VERSION} or later, and the walkdiff.command setting runs ${found.join(".")}. Update it, or use the default setting, which takes the newest from npm.`
}
