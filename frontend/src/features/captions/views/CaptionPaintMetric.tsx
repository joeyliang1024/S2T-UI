import { useEffect, useRef } from 'react'
import type { TranscriptEvent } from '../../models/model-adapter'
import { discardCaptionPaint, reportCaptionPaint, reportTranslationPaint } from '../../../shared/services/caption-metrics'
export const CaptionPaintMetric = ({ members, text, translation = false }: { members: TranscriptEvent[]; text: string; translation?: boolean }): React.JSX.Element => {
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const element = ref.current
        if (!element || !text.trim()) return
        const rect = element.getBoundingClientRect()
        const clip = element.closest('.transcript')?.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight || (clip && (rect.bottom <= clip.top || rect.top >= clip.bottom))) { discardCaptionPaint(members.map(member => member.id), translation); return }
        const report = translation ? reportTranslationPaint : reportCaptionPaint
        report(members.map(member => member.id), performance.now())
      })
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [members, text, translation])
  return <p ref={ref} className={translation ? 'translation' : undefined}>{text}</p>
}
