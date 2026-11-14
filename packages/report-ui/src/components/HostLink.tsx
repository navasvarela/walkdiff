import type { ReactElement, ReactNode } from "react"

interface HostLinkProps {
  /** Undefined for a local branch, which has no web page: then nothing is shown. */
  readonly url: string | undefined
}

/** The ↗ that opens a line on the host's file viewer, beside a finding or citation. */
export function HostLink({ url }: HostLinkProps): ReactElement | null {
  if (url === undefined) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open on the host">
      ↗
    </a>
  )
}

interface SourceLocationProps {
  readonly url: string | undefined
  readonly children: ReactNode
}

/** A path and line, linked to the host's file viewer when the change has one. */
export function SourceLocation({ url, children }: SourceLocationProps): ReactElement {
  if (url === undefined) return <span>{children}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}
