export {}

declare global {
  interface Window {
    s2t?: {
      saveModelApiKey: (profileId: string, apiKey: string) => Promise<void>
      hasModelApiKey: (profileId: string) => Promise<boolean>
      getEnvironmentAsr: () => Promise<{ endpoint: string; model: string; configured: boolean }>
      loadModelConfig: () => Promise<Partial<SettingsConfig> | null>
      saveModelConfig: (config: SettingsConfig) => Promise<{ saved: boolean }>
      transcribeAudioChunk: (input: { profileId: string; endpoint: string; model: string; language: string; prompt?: string; filename?: string; contentType?: string; audio: ArrayBuffer }) => Promise<{ text: string }>
      completeText: (input: { profileId: string; endpoint: string; model: string; messages: Array<{ role: 'system' | 'user'; content: string }> }) => Promise<{ text: string }>
      diarizeAudio: (input: { endpoint: string; model: string; audio: ArrayBuffer }) => Promise<unknown>
      startPcmRecording: (sampleRate: number) => Promise<{ id: string }>
      appendPcm: (id: string, audio: ArrayBuffer) => void
      finishPcmRecording: (id: string) => Promise<{ audioPath: string }>
      abortPcmRecording: (id: string) => Promise<void>
      readAudio: (audioPath: string) => Promise<ArrayBuffer>
      saveSession: (input: { name: string; audio?: ArrayBuffer; recordingPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; segments: unknown[] }) => Promise<{ canceled: boolean; audioPath?: string; directory?: string }>
      openSession: () => Promise<{ canceled: boolean; session?: { id: string; title: string; createdAt: string; durationMs: number; source: string; transcript: string; audioKey: string; nativeAudioPath: string; savedToDisk: boolean; segments: unknown[] } }>
      listRecoverableRecordings: () => Promise<Array<{ id: string; path: string; audioPath: string; sampleRate: number; createdAt: string; state: 'active' | 'finished' }>>
      discardRecoverableRecording: (id: string) => Promise<void>
      toggleFloatingCaptions: (visible: boolean) => void
      updateFloatingCaption: (text: string) => void
      onFloatingCaption: (listener: (text: string) => void) => () => void
    }
  }
}

interface SettingsConfig {
  sourceLanguage: string
  targetLanguage: string
  modelProfiles: Array<{ id: string; name: string; endpoint: string; model: string; kind: 'websocket' | 'openai-http'; capabilities: { asrMode: 'streaming' | 'non-streaming'; vadSource: 'app' | 'server'; timestampPrecision: 'chunk' | 'segment' | 'word' } }>
  selectedModelId: string
  translationEndpoint: string
  translationModel: string
  translationProfiles: Array<{ id: string; name: string; endpoint: string; model: string }>
  selectedTranslationModelId: string
  summaryEndpoint: string
  summaryModel: string
  diarizationEndpoint: string
  diarizationModel: string
  glossary: string
  vadConfig: { minSpeechMs: number; minSilenceMs: number; preRollMs: number; noiseFloorOffsetDb: number }
}
