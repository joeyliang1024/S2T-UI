import { StudioArtwork } from '../../../shared/ui/StudioArtwork'
import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { SavedSession } from '../../../shared/types'
import { comparisonRows, comparisonText, type ComparisonKind, type DiffRow } from '../domain/comparison'
import { correctionRuns } from '../../transcript/services/quality-correction'


const QualityDiff = memo(function QualityDiff({ rows, label, beforeLabel, afterLabel }: { rows: DiffRow[]; label: string; beforeLabel: string; afterLabel: string }): ReactElement {
  return (
      <div className="quality-diff-scroll" tabIndex={0} role="region" aria-label={label}>
        <div className="quality-diff-head"><strong>− {beforeLabel}</strong><strong>+ {afterLabel}</strong></div>
        <div className="quality-diff-body">{rows.map((row, index) => <div className="quality-diff-row" key={index}>{(['before', 'after'] as const).map(side => {
          const text = row[side], opposite = row[side === 'before' ? 'after' : 'before'] ?? ''
          const runs = row.changed && text !== undefined ? correctionRuns(opposite, text) : [{ text: text ?? '', changed: false }]
          return <div key={side} className={`quality-diff-cell ${row.changed && text !== undefined ? `quality-diff-${side}` : ''}`}><span className="quality-diff-number" aria-hidden="true">{row[side === 'before' ? 'beforeLine' : 'afterLine']}</span><span className="quality-diff-sign" aria-hidden="true">{row.changed && text !== undefined ? side === 'before' ? '−' : '+' : ''}</span><pre>{runs.map((part, n) => part.changed ? <mark key={n}>{part.text}</mark> : <span key={n}>{part.text}</span>)}</pre></div>
        })}</div>)}</div>
      </div>
  )
})

type Progress = { stage: 'loading' | 'asr' | 'diarization' | 'translation' | 'completed' | 'failed'; completed: number; total: number; error?: string }
type Props = { sessionId?: string | null; onSelectSession?: (id: string) => void; sessions: SavedSession[]; progress: Record<string, Progress>; correct: (session: SavedSession, items?: ComparisonKind[]) => Promise<void>; canCorrect: boolean; canDiarize?: boolean; canTranslate?: boolean; locale?: string; ui: (key: string) => string }
export function QualityComparisonWorkspace({ sessionId, onSelectSession, sessions, progress, correct, canCorrect, canDiarize = true, canTranslate = true, locale, ui }: Props): ReactElement {
  // A checkbox is disabled only by capability or while a run is busy, never by
  // its own selection state, so unchecking an item can never strand it disabled.
  const available = (kind: ComparisonKind): boolean => kind === 'transcript' ? canCorrect : kind === 'diarization' ? canDiarize : canTranslate
  const [items, setItems] = useState<ComparisonKind[]>(() => (['transcript', 'diarization'] as const).filter(kind => available(kind)) as ComparisonKind[])
  const picker = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    if (!pickerOpen) return
    const close = (event: PointerEvent): void => { if (event.target instanceof Node && !picker.current?.contains(event.target)) setPickerOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [pickerOpen])
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState<ComparisonKind>('transcript')
  const [baseline, setBaseline] = useState<{ id: string; texts: Record<ComparisonKind, string> } | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const starting = useRef(false)
  const session = sessions.find(entry => entry.id === (sessionId ?? selectedId)) ?? sessions[0]
  const state = session ? progress[session.id] : undefined
  const busy = Boolean(session && (startingId === session.id || state && !['completed', 'failed'].includes(state.stage)))
  const texts = useMemo(() => session ? comparisonText(session, tab) : null, [session, tab])
  const before = session && baseline?.id === session.id ? baseline.texts[tab] : texts?.before ?? ''
  const after = texts?.after ?? ''
  const rows = useMemo(() => comparisonRows(before, after), [before, after])
  const changed = rows.filter(row => row.changed).length
  const requiresAudio = items.includes('transcript') || items.includes('diarization')
  const unavailable = items.includes('transcript') && !canCorrect || items.includes('diarization') && !canDiarize || items.includes('translation') && !canTranslate
  const disabled = !session || !items.length || startingId !== null || busy || session.processingState === 'running' || unavailable || requiresAudio && (session.audioUnavailable || (!session.audioKey && !session.nativeAudioPath)) || !session.segments.some(segment => segment.status === 'final' && segment.sourceText.trim())
  const run = async (): Promise<void> => {
    if (!session || disabled || starting.current) return
    starting.current = true
    setBaseline({ id: session.id, texts: { transcript: comparisonText(session, 'transcript').after, diarization: comparisonText(session, 'diarization').after, translation: comparisonText(session, 'translation').after } })
    setStartingId(session.id)
    setPickerOpen(false)
    try { await correct(session, [...items]) } finally { starting.current = false; setStartingId(null) }
  }
  const stageKey = state?.stage === 'asr' ? 'qualityCorrectionAsr' : state?.stage === 'diarization' ? 'recordProcessingDiarization' : state?.stage === 'translation' ? 'translation' : state?.stage === 'completed' ? 'recordProcessingCompleted' : state?.stage === 'failed' ? 'recordProcessingFailed' : 'qualityCorrectionLoading'
  return <section className="page-panel quality-comparison">
    <div className="page-title"><div><p className="eyebrow">{ui('eyebrowQualityComparison')}</p><h2 title={ui('qualityCompareHint')}>{ui('qualityCompare')}</h2></div><StudioArtwork variant="quality" className="page-art" /></div>
    <div className="quality-comparison-controls">
      <label>{ui('qualityCompareRecord')}<select value={session?.id ?? ''} onChange={event => { setSelectedId(event.target.value); onSelectSession?.(event.target.value) }}><option value="" disabled>{ui('notSelected')}</option>{sessions.map(entry => <option key={entry.id} value={entry.id}>{entry.title || ui('untitledRecord')} · {new Date(entry.createdAt).toLocaleString(locale)}</option>)}</select></label>
      <div className="quality-correction-picker" ref={picker} onKeyDown={event => { if (event.key === 'Escape') { setPickerOpen(false); picker.current?.querySelector('button')?.focus() } }}>
        <button type="button" className="quality-correction-trigger" aria-label={ui('qualityCorrectionItems')} aria-expanded={pickerOpen} aria-controls="quality-correction-options" onClick={() => setPickerOpen(current => !current)}>{ui('qualityCorrectionItems')} · {items.length}<span aria-hidden="true">▾</span></button>
        {pickerOpen && <div id="quality-correction-options" className="quality-correction-options">{(['transcript', 'diarization', 'translation'] as const).map(kind => <label key={kind}><input type="checkbox" checked={items.includes(kind)} disabled={busy || !available(kind)} onChange={event => { const checked = event.currentTarget.checked; setItems(current => checked ? current.includes(kind) ? current : [...current, kind] : current.filter(item => item !== kind)) }} />{ui(kind === 'transcript' ? 'qualityCompareTranscript' : kind === 'diarization' ? 'modelCategoryDiarization' : 'translation')}</label>)}</div>}
      </div>
      <button className="primary" disabled={Boolean(disabled)} onClick={() => void run()}>{busy ? ui('qualityCompareRunning') : ui('qualityCorrection')}</button>
    </div>
    {!canCorrect && <p className="hint">{ui('qualityCompareModelRequired')}</p>}
    {requiresAudio && session && (session.audioUnavailable || (!session.audioKey && !session.nativeAudioPath)) && <p className="hint">{ui('qualityCompareAudioRequired')}</p>}
    {(busy || state?.stage === 'failed') && <div className="quality-comparison-progress" role="status" aria-live="polite"><span>{ui(stageKey)}{state && state.total > 0 ? ` · ${state.completed}/${state.total}` : ''}</span>{busy && <progress aria-label={ui('qualityCorrection')} max={state?.total || 1} value={state?.total ? state.completed : undefined} />}{(state?.error || session?.qualityCorrectionError) && <p role="alert">{state?.error || session?.qualityCorrectionError}</p>}</div>}
    {!state && session?.qualityCorrectionError && <p role="alert">{session.qualityCorrectionError}</p>}
    {!session ? <div className="empty"><p>{ui('noHistory')}</p></div> : <>
      <div className="quality-comparison-toolbar"><div className="quality-comparison-tabs" role="tablist" aria-label={ui('qualityCompare')} onKeyDown={event => {
        const tabs: ComparisonKind[] = ['transcript', 'diarization', 'translation']
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3
        setTab(tabs[index]); document.getElementById(`quality-tab-${tabs[index]}`)?.focus()
      }}>{(['transcript', 'diarization', 'translation'] as const).map(kind => <button type="button" role="tab" id={`quality-tab-${kind}`} aria-controls="quality-comparison-panel" tabIndex={tab === kind ? 0 : -1} aria-selected={tab === kind} key={kind} onClick={() => setTab(kind)}>{ui(kind === 'transcript' ? 'qualityCompareTranscript' : kind === 'diarization' ? 'modelCategoryDiarization' : 'translation')}</button>)}</div>
      <p className="hint">{busy ? ui('qualityCompareWaiting') : !texts?.hasBaseline && baseline?.id !== session.id ? ui('qualityCompareNoBaseline') : changed ? ui('qualityCompareChanges').replace('{count}', String(changed)) : ui('qualityCompareUnchanged')}</p></div>
      <div role="tabpanel" id="quality-comparison-panel" aria-labelledby={`quality-tab-${tab}`}>
      {!before && !after && <p className="hint">{ui('qualityCompareNoData')}</p>}
      <QualityDiff rows={rows} label={ui('qualityCompare')} beforeLabel={ui('qualityCompareBefore')} afterLabel={ui('qualityCompareAfter')} /></div>
    </>}
  </section>
}
