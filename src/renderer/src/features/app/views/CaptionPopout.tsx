import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { LiveCaptionGroup } from '../services/live-caption'
import { timestamp } from '../../../shared/services/transcript'

type Props = { captionScale: number; entries: LiveCaptionGroup[]; fullscreen: boolean; fullscreenLabel: string; waitingLabel: string; speakerLabel: string; stageLabel: string; speakerColon: string; toggleFullscreen: () => void; fullscreenError?: string }
export function CaptionPopout({ captionScale, entries, fullscreen, fullscreenLabel, waitingLabel, speakerLabel, stageLabel, speakerColon, toggleFullscreen, fullscreenError }: Props): ReactElement {
  const stageRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const timerRef = useRef<number | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const reveal = (): void => {
    const win = stageRef.current?.ownerDocument.defaultView
    if (!win) return
    setControlsVisible(true)
    if (timerRef.current !== null) win.clearTimeout(timerRef.current)
    timerRef.current = win.setTimeout(() => setControlsVisible(false), 2000)
  }
  useEffect(() => {
    reveal()
    const win = stageRef.current?.ownerDocument.defaultView
    const resize = (): void => { const list = listRef.current; if (list && followingRef.current) list.scrollTop = list.scrollHeight }
    win?.addEventListener('resize', resize)
    return () => { if (timerRef.current !== null) win?.clearTimeout(timerRef.current); win?.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => { if (fullscreenError) reveal() }, [fullscreenError])
  useEffect(() => { const list = listRef.current; if (list && followingRef.current) list.scrollTop = list.scrollHeight }, [entries])
  return <section ref={stageRef} className="caption-popout-stage" style={{ '--caption-scale': captionScale } as CSSProperties} aria-label={stageLabel} onPointerMove={reveal} onPointerDown={reveal} onFocusCapture={reveal}>
    <div ref={listRef} className="caption-popout-transcript" aria-live="polite" onScroll={(event) => { const list = event.currentTarget; followingRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48 }}>
      {entries.length ? entries.slice(-8).map((entry) => <article key={entry.id}><time>{timestamp(entry.startMs)}</time><p><strong>{entry.speaker?.trim() || speakerLabel}{speakerColon}</strong>{entry.sourceText}</p>{entry.translatedText && <p className="translation"><strong>{entry.speaker?.trim() || speakerLabel}{speakerColon}</strong>{entry.translatedText}</p>}</article>) : <p className="caption-popout-waiting">{waitingLabel}</p>}
    </div>
    {fullscreenError && <p className="caption-popout-error" role="alert">{fullscreenError}</p>}
    <div className={`caption-popout-controls${controlsVisible ? ' visible' : ''}`}>
      <button type="button" aria-label={fullscreenLabel} title={fullscreenLabel} onClick={toggleFullscreen}><svg viewBox="0 0 24 24" aria-hidden="true">{fullscreen ? <path d="M8 3v5H3M16 3v5h5M3 16h5v5M21 16h-5v5" /> : <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />}</svg></button>
    </div>
  </section>
}
