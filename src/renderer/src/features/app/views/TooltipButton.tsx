import { useState, type ButtonHTMLAttributes, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { tooltip: string; placement?: 'right' | 'above' }
export function TooltipButton({ tooltip, placement = 'above', children, onMouseEnter, onMouseLeave, onFocus, onBlur, ...props }: Props): ReactElement {
  const [anchor, setAnchor] = useState<{ document: Document; left: number; top: number } | null>(null)
  const show = (button: HTMLButtonElement): void => {
    const rect = button.getBoundingClientRect()
    setAnchor({ document: button.ownerDocument, left: placement === 'right' ? rect.right + 8 : rect.left + rect.width / 2, top: placement === 'right' ? rect.top + rect.height / 2 : rect.top - 8 })
  }
  return <><button {...props} aria-label={props['aria-label'] || tooltip} onMouseEnter={(event) => { show(event.currentTarget); onMouseEnter?.(event) }} onMouseLeave={(event) => { setAnchor(null); onMouseLeave?.(event) }} onFocus={(event) => { show(event.currentTarget); onFocus?.(event) }} onBlur={(event) => { setAnchor(null); onBlur?.(event) }}>{children}</button>{anchor && createPortal(<span role="tooltip" className={`icon-tooltip ${placement}`} style={{ left: anchor.left, top: anchor.top }}>{tooltip}</span>, anchor.document.body)}</>
}
