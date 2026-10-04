import type { ReactElement } from 'react'
import type { View } from '../../../shared/types'

// Shared 24px grid, rounded strokes and a quiet surface keep both themes consistent.
export function NavigationGlyph({ name }: { name: View }): ReactElement {
  switch (name) {
    case 'live': return <><path className="nav-glyph-surface" d="M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-5 3v-3a3 3 0 0 1-3-3V8a4 4 0 0 1 4-4Z" /><path d="M7 9v4m3-6v8m4-6v4m3-3v2" /></>
    case 'history': return <><circle className="nav-glyph-surface" stroke="none" cx="12" cy="12" r="8" /><path d="M4.6 7.4A8.5 8.5 0 1 1 3.5 13M3.5 4v4h4M12 7.5V12l3 2" /></>
    case 'summary': return <><path className="nav-glyph-surface" d="M6 3h8l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v4h4M8 11h6M8 15h4M8 18h3" /><path className="nav-glyph-accent" d="m18 11 .8 2.2L21 14l-2.2.8L18 17l-.8-2.2L15 14l2.2-.8Z" /></>
    case 'import': return <><path className="nav-glyph-surface" d="M4 13h4l2 3h4l2-3h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M12 3v10m-4-4 4 4 4-4M4 13h4l2 3h4l2-3h4" /></>
    case 'models': return <><rect className="nav-glyph-surface" x="6" y="6" width="12" height="12" rx="3" /><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3M10 10h4v4h-4Z" /></>
    case 'voiceprints': return <><path d="M5 9a7 7 0 0 1 14 0M3 12V9m18 0v3M8 19c-1.8-2.5-2-5-2-8a6 6 0 0 1 12 0c0 4-.6 7-2 10M10 21c-2-3-2-6-2-10a4 4 0 0 1 8 0c0 3.5-.3 6-1 8M12 9a2 2 0 0 1 2 2c0 4-.3 7-1 10M10 11c0 2.5 0 4 .5 5" /></>
    case 'settings': return <><path d="M5 3v4m0 4v10M12 3v10m0 4v4M19 3v4m0 4v10" /><rect className="nav-glyph-surface" x="2.5" y="7" width="5" height="4" rx="1.5" /><rect className="nav-glyph-surface" x="9.5" y="13" width="5" height="4" rx="1.5" /><rect className="nav-glyph-surface" x="16.5" y="7" width="5" height="4" rx="1.5" /></>
    default: return <circle cx="12" cy="12" r="8" />
  }
}
