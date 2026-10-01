import { type ReactElement } from 'react'
import { interfaceTranslate } from '../../../shared/i18n'
import { audioDownloadFormats, type AudioDownloadFormat } from '../services/audio-export'
import { summaryDownloadFormats, type SummaryDownloadFormat } from '../services/summary-document'
import { transcriptDownloadFormats, type TranscriptDownloadFormat } from '../services/transcript-documents'

type Ui = (key: Parameters<typeof interfaceTranslate>[1]) => string

export type DownloadScope = 'all' | 'audio' | 'transcript' | 'summary'
export type DownloadPick = { kind: 'audio'; format: AudioDownloadFormat } | { kind: 'transcript'; format: TranscriptDownloadFormat } | { kind: 'summary'; format: SummaryDownloadFormat }

type DownloadPickerProps = {
  ui: Ui
  title: string
  scope: DownloadScope
  busy: boolean
  error: string | null
  onPick: (pick: DownloadPick) => void
  onClose: () => void
}

const audioHints: Record<AudioDownloadFormat, Parameters<Ui>[0]> = { wav: 'formatWav', m4a: 'formatM4a' }
const transcriptHints: Record<TranscriptDownloadFormat, Parameters<Ui>[0]> = {
  docx: 'formatDocx',
  xlsx: 'formatXlsx',
  csv: 'formatCsv',
  txt: 'formatTxt',
  vtt: 'formatVtt'
}
const summaryHints: Record<SummaryDownloadFormat, Parameters<Ui>[0]> = { txt: 'formatTxt', markdown: 'formatMarkdown', docx: 'formatDocx' }

/** One download per pick: the user chooses the format instead of receiving every export at once. */
export function DownloadPicker({ ui, title, scope, busy, error, onPick, onClose }: DownloadPickerProps): ReactElement {
  const showAudio = scope === 'all' || scope === 'audio'
  const showTranscript = scope === 'all' || scope === 'transcript'
  const showSummary = scope === 'summary'
  return (
    <div className="transcript-modal-backdrop download-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="transcript-modal download-picker" role="dialog" aria-modal="true" aria-label={ui('chooseDownloadFormat')} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow">DOWNLOAD</p><h2>{ui('chooseDownloadFormat')}</h2><p className="hint">{title}</p></div>
          <button type="button" className="text-button" disabled={busy} onClick={onClose}>{ui('close')}</button>
        </header>
        {showAudio && <div className="download-picker-group">
          <h3>{ui('audioFile')}</h3>
          <div className="download-picker-options">
            {audioDownloadFormats.map((format) => (
              <button key={format} type="button" disabled={busy} onClick={() => onPick({ kind: 'audio', format })}>
                <span className="download-format-badge">{format.toUpperCase()}</span>
                <span className="download-format-hint">{ui(audioHints[format])}</span>
              </button>
            ))}
          </div>
        </div>}
        {showTranscript && <div className="download-picker-group">
          <h3>{ui('transcriptFile')}</h3>
          <div className="download-picker-options">
            {transcriptDownloadFormats.map((format) => (
              <button key={format} type="button" disabled={busy} onClick={() => onPick({ kind: 'transcript', format })}>
                <span className="download-format-badge">{format.toUpperCase()}</span>
                <span className="download-format-hint">{ui(transcriptHints[format])}</span>
              </button>
            ))}
          </div>
        </div>}
        {showSummary && <div className="download-picker-group">
          <h3>{ui('summaryTitle')}</h3>
          <div className="download-picker-options">
            {summaryDownloadFormats.map((format) => (
              <button key={format} type="button" disabled={busy} onClick={() => onPick({ kind: 'summary', format })}>
                <span className="download-format-badge">{format.toUpperCase()}</span>
                <span className="download-format-hint">{ui(summaryHints[format])}</span>
              </button>
            ))}
          </div>
        </div>}
        {busy && <p className="download-picker-status" role="status">{ui('preparingDownload')}</p>}
        {error && <p className="download-picker-error" role="alert">{error}</p>}
      </section>
    </div>
  )
}
