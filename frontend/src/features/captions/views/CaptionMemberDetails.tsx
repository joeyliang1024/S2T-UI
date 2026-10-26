import { type ReactNode, useState } from 'react'

// Native details hide content visually but still mount its entire React tree.
// Build member editors only when expanded, keeping long transcripts responsive.
export const CaptionMemberDetails = ({ summary, editing, children }: {
  summary: string
  editing: boolean
  children: () => ReactNode
}): ReactNode => {
  const [expanded, setExpanded] = useState(false)
  const open = editing || expanded
  return <details open={open} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && children()}
  </details>
}
