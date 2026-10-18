import type { ReactElement } from 'react'

export type StudioArtworkKind = 'live' | 'history' | 'summary' | 'quality' | 'models' | 'voiceprints' | 'settings' | 'import'

/** Decorative artwork is deliberately separate from controls and live regions. */
export function StudioArtwork({ variant, className = '' }: { variant: StudioArtworkKind; className?: string }): ReactElement {
  return <div className={`studio-artwork studio-artwork-${variant} ${className}`} aria-hidden="true">
    <span className="studio-artwork-image" />
    <span className="studio-artwork-motion"><i /><i /><i /></span>
  </div>
}
