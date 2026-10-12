import { memo, useMemo } from 'react'
import type { TranscriptEvent } from '../../models/model-adapter'
import { joinCaptionText } from '../../../shared/services/transcript'
import { correctionRuns } from '../services/quality-correction'
export const CorrectedText = memo(({ text, original }: { text: string; original?: string }): React.JSX.Element => {
  const runs = useMemo(() => original === undefined ? [{ text, changed: false }] : correctionRuns(original, text), [original, text])
  return <>{runs.map((run, index) => run.changed
    ? <mark className="correction-highlight" key={index}>{run.text}</mark> : <span key={index}>{run.text}</span>)}</>
})

export const CorrectedCaptionText = ({ text, members }: { text: string; members: TranscriptEvent[] }): React.JSX.Element => {
  const original = members.some(member => member.correctionOriginalText !== undefined)
    ? members.reduce((previous, member) => joinCaptionText(previous, member.correctionOriginalText ?? member.sourceText), '')
    : undefined
  return <CorrectedText text={text} original={original} />
}
