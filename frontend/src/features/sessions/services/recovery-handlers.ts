import type { SavedSession, AudioVersion } from '../../../../shared/contracts/sessions'
import type { Settings } from '../../../../shared/contracts/settings'
import type { ModelProfile } from '../../../../shared/contracts/models'
import type { TranscriptEvent } from '../../../../shared/contracts/transcript'
import type { TranslateCaption } from '../../translation/services/queue'
import { recoverSession, sessionRecoveryStages } from '../domain/recovery'
import { readPcmWavFileLayout, readPcmWavFileChunk } from '../../transcript/wav-batch'
import { makeTranscriptText } from '../../../shared/services/transcript'
import { chooseModelSampleRate } from '../../capture/resample'
import { parseSpeakerTurns, assignSpeakersByOverlap } from '../../speakers/diarization'
import { asrLanguage } from '../../../shared/services/settings'
import { resolveTranslationTarget, shouldSkipTranslation } from '../../translation/domain/policy'
import { readJsonResponse } from '../../../shared/services/http'

export interface RecoveryDependencies {
  settings: Pick<Settings, 'sourceLanguage' | 'targetLanguage' | 'glossary' | 'translationModel' | 'translationEndpoint' | 'diarizationProfiles' | 'diarizationEndpoint' | 'diarizationModel'>
  selectedModel: ModelProfile
  webGatewayAsrProfileId: string | null
  activeRecoveries: Set<string>
  qualityCorrectionActive: ReadonlySet<string>
  loadSessionAudio: (session: SavedSession, attempts?: number) => Promise<Blob | undefined>
  audioVersionsFor: (session: SavedSession) => AudioVersion[]
  activeAudioVersionFor: (session: SavedSession) => AudioVersion
  resampleAudioForAsr: (audio: ArrayBuffer, rate: number) => Promise<ArrayBuffer>
  requestBrowserAsr: (input: RequestInit) => Promise<Response>
  authFetch: (path: string, input?: RequestInit) => Promise<Response>
  saveAudio: (id: string, audio: Blob, attempts?: number) => Promise<void>
  translate: TranslateCaption
  publish: (updated: SavedSession, previousToken: string | undefined, token: string | undefined) => void
  setStatus: (message: string) => void
  activeTranslate: (key: string) => string
}

export const retrySession = async (dependencies: RecoveryDependencies, entry: SavedSession, backup?: File, legacyStage?: 'asr' | 'translation' | 'diarization' | 'saving'): Promise<void> => {
    const { settings, selectedModel, webGatewayAsrProfileId, loadSessionAudio, setStatus, activeTranslate,
      audioVersionsFor, activeAudioVersionFor, resampleAudioForAsr, requestBrowserAsr, authFetch, translate } = dependencies
    const recoveryActive = dependencies.activeRecoveries, qualityCorrectionActive = dependencies.qualityCorrectionActive

    if (entry.processingState === 'running' || qualityCorrectionActive.has(entry.id) || recoveryActive.has(entry.id)) return
    const fullAsr = (legacyStage === 'asr' && !sessionRecoveryStages(entry).length) || entry.recoveryFullAsr === true
    if (legacyStage && !sessionRecoveryStages(entry).length) {
      if (legacyStage === 'translation' && !entry.segments.some(segment => segment.status === 'final')) {
        if (!entry.transcript?.trim()) { setStatus(activeTranslate('titleTranscriptRequired')); return }
        entry = { ...entry, segments: [{ id: crypto.randomUUID(), revision: 1, status: 'final', startMs: 0, endMs: Math.max(1, entry.durationMs), sourceText: entry.transcript }] }
      }
      entry = { ...entry, processingFailures: [legacyStage], recoveryFullAsr: fullAsr, processingStage: undefined, diarizationJobId: undefined, ...(legacyStage === 'translation' ? { segments: entry.segments.map(segment => segment.status === 'final' ? { ...segment, translationStatus: 'failed' as const } : segment) } : {}) }
    }
    const token = crypto.randomUUID()
    recoveryActive.add(entry.id)
    let audio: Blob | undefined
    const audioForRecovery = async (): Promise<Blob> => {
      if (!audio) audio = backup || await loadSessionAudio(entry, 1)
      if (!audio) throw new Error(activeTranslate('recoveryAudioRequired'))
      return audio
    }
    const patch = (updated: SavedSession): void => dependencies.publish(updated, entry.processingToken, token)
    const withSegments = (current: SavedSession, segments: TranscriptEvent[]): SavedSession => {
      const transcript = makeTranscriptText(segments)
      return { ...current, segments, transcript, audioVersions: current.audioVersions?.map(version => version.id === (current.activeAudioVersionId || 'original') ? { ...version, segments, transcript } : version) }
    }
    try {
      if (!entry.processingFailures && entry.processingState === 'failed' && entry.diarizationJobId) {
        const response = await authFetch(`/api/data/diarization-jobs?id=${encodeURIComponent(entry.diarizationJobId)}`)
        const payload = await response.json() as { job?: { state?: string }; error?: string }
        if (!response.ok && response.status !== 404) throw new Error(payload.error || `HTTP ${response.status}`)
        if (payload.job?.state === 'pending' || payload.job?.state === 'running') {
          dependencies.publish({ ...entry, processingState: 'running', processingStage: 'diarization' }, entry.processingToken, entry.processingToken)
          return
        }
        entry = { ...entry, processingFailures: [...new Set([...sessionRecoveryStages(entry), ...(response.status === 404 || payload.job?.state === 'failed' ? ['diarization' as const] : [])])] }
      }
      const result = await recoverSession({ ...entry, processingToken: token, diarizationJobId: undefined }, {
        saving: async (current, publish) => {
          if (current.audioUnavailable === true || backup) {
            const recovered = await audioForRecovery()
            if (backup) {
              const layout = await readPcmWavFileLayout(backup)
              const duration = layout.dataBytes / layout.bytesPerFrame / layout.sampleRate * 1000
              if (Math.abs(duration - entry.durationMs) > Math.max(2000, entry.durationMs * .05)) throw new Error('WAV duration does not match this recording.')
            }
            await dependencies.saveAudio(activeAudioVersionFor(current).audioKey, recovered, 1)
            current = { ...current, audioUnavailable: false }; publish(current)
          }
          {
            const response = await authFetch('/api/data/storage-retry', { method: 'POST' })
            if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`)
          }
          return current
        },
        asr: async (current, publish) => {
          let gaps = current.segments.filter(segment => segment.status === 'gap')
          if (!gaps.length && !fullAsr) throw new Error(activeTranslate('recoveryNoAsrRange'))
          if (selectedModel.kind !== 'openai-http') throw new Error(activeTranslate('stSelectOpenAiCompatibleAsrModel'))
          const file = new File([await audioForRecovery()], 'recovery.wav', { type: 'audio/wav' })
          const layout = await readPcmWavFileLayout(file)
          if (fullAsr) {
            const durationMs = layout.dataBytes / layout.bytesPerFrame / layout.sampleRate * 1000
            if (!durationMs) throw new Error(activeTranslate('recoveryNoAsrRange'))
            const versionId = crypto.randomUUID()
            gaps = [{ id: crypto.randomUUID(), revision: 1, status: 'gap', startMs: 0, endMs: durationMs, sourceText: '' }]
            // Persist retry ranges before calling the provider. Preserve the
            // previous transcript as a selectable audio version.
            current = { ...current, recoveryFullAsr: false, activeAudioVersionId: versionId, segments: gaps, audioVersions: [...audioVersionsFor(current), { id: versionId, audioKey: activeAudioVersionFor(current).audioKey, nativeAudioPath: activeAudioVersionFor(current).nativeAudioPath, createdAt: new Date().toISOString(), label: activeTranslate('legacyRecoverAsr'), parentId: current.activeAudioVersionId || 'original', segments: gaps, transcript: '' }] }
            publish(current)
          }
          for (const gap of gaps) {
            if (gap.startMs < 0 || gap.endMs <= gap.startMs || gap.endMs > layout.dataBytes / layout.bytesPerFrame / layout.sampleRate * 1000 + 50) throw new Error('Failed audio range is outside the recording.')
            for (let start = gap.startMs; start < gap.endMs; start += 30000) {
              const startByte = Math.floor(start * layout.sampleRate / 1000) * layout.bytesPerFrame
              if (startByte >= layout.dataBytes) throw new Error('Failed audio range is outside the recording.')
              const chunk = await readPcmWavFileChunk(file, layout, startByte, Math.min(30000, gap.endMs - start))
              const rate = chooseModelSampleRate(layout.sampleRate, selectedModel.capabilities.supportedSampleRates ?? [])
              const data = rate === layout.sampleRate ? chunk.audio : await resampleAudioForAsr(chunk.audio, rate)
              const payload = (await readJsonResponse<{ text?: string }>(await requestBrowserAsr({ method: 'POST', headers: { 'content-type': 'audio/wav', ...(webGatewayAsrProfileId ? { 'x-s2t-model-id': webGatewayAsrProfileId } : {}), ...(asrLanguage(settings.sourceLanguage) ? { 'x-s2t-language': asrLanguage(settings.sourceLanguage) } : {}), ...(settings.glossary ? { 'x-s2t-prompt': encodeURIComponent(settings.glossary) } : {}) }, body: data }), activeTranslate('stFinalAsrServiceLabel')))
              if (!payload.text?.trim()) throw new Error(activeTranslate('stAsrReturnedNoTranscript'))
              const recovered: TranscriptEvent = { id: crypto.randomUUID(), revision: 1, status: 'final', startMs: chunk.startMs, endMs: chunk.endMs, sourceText: payload.text }
              const remainingGap: TranscriptEvent[] = chunk.endMs < gap.endMs ? [{ ...gap, startMs: chunk.endMs }] : []
              current = { ...withSegments(current, current.segments.flatMap(segment => segment.id === gap.id ? [recovered, ...remainingGap] : [segment])), summary: undefined, summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined, summarySourceSignature: undefined, summarySourceVersionId: undefined }
              publish(current)
            }
          }
          return { ...current, summary: undefined, summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined, summarySourceSignature: undefined, summarySourceVersionId: undefined }
        },
        translation: async (current, publish) => {
          if (!settings.translationModel.trim() || false) throw new Error(activeTranslate('stWebTranslationGateway') + ': model not configured')
          const segments = [...current.segments]
          for (let index = 0; index < segments.length; index++) {
            const segment = segments[index]
            if (segment.status !== 'final' || (segment.translatedText && segment.translationStatus !== 'failed')) continue
            if (shouldSkipTranslation(segment.detectedLanguage, resolveTranslationTarget(segment.detectedLanguage, settings.targetLanguage))) {
              segments[index] = { ...segment, translationStatus: 'completed', translationAttempts: undefined }
              current = withSegments(current, [...segments]); publish(current)
              continue
            }
            const { text } = await translate(segment, new AbortController().signal, 90_000)
            if (!text.trim()) throw new Error('Translation service returned no text.')
            segments[index] = { ...segment, translatedText: text, translationStatus: 'completed', translationAttempts: undefined }
            current = withSegments(current, [...segments]); publish(current)
          }
          return current
        },
        diarization: async current => {
          const recovered = await audioForRecovery()
          const local = settings.diarizationProfiles?.some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint)
          const payload = (await readJsonResponse<unknown>(await authFetch('/api/diarizations', { method: 'POST', headers: { 'content-type': 'audio/wav', ...(local ? { 'x-s2t-diarization-model': settings.diarizationModel } : settings.diarizationEndpoint !== '/api/diarizations' ? { 'x-s2t-model-id': 'managed-diarization' } : {}) }, body: recovered, signal: AbortSignal.timeout(120000) }), activeTranslate('stDiarizationServiceLabel')))
          const turns = parseSpeakerTurns(payload)
          if (!turns.length) throw new Error(activeTranslate('stDiarizationNoSegments'))
          const assigned = assignSpeakersByOverlap(current.segments, turns)
          return { ...withSegments(current, assigned.map((segment, index) => current.segments[index].speakerManuallyEdited ? current.segments[index] : segment)), diarizationJobId: undefined }
        }
      }, patch)
      setStatus(result.processingState === 'failed' ? result.processingError || activeTranslate('errorRecovery') : activeTranslate('recordProcessingCompleted'))
    } catch (error) { setStatus(error instanceof Error ? error.message === 'session-recovery-unknown-stage' ? activeTranslate('recoveryUnknownStage') : error.message : activeTranslate('errorRecovery')) }
    finally { recoveryActive.delete(entry.id) }
  }
