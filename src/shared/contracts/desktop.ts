import type { Settings } from './settings'
type SettingsConfig = Settings

export type EnvironmentModels = Partial<Record<'asr' | 'translation' | 'summary' | 'diarization', { endpoint: string; sourceEndpoint?: string; model: string; configured: boolean }>> & {
    diarizationProfiles?: Array<{ id: string; name: string; endpoint: string; model: string; configured: boolean }>
    branding?: { titleImage: string }
    prompts?: Record<string, string>
    asrProfiles?: Array<{ id: string; name: string; endpoint: string; sourceEndpoint?: string; model: string; configured: boolean }>
  }
export interface DesktopBridge {
      systemLanguages: string[]
      getGatewayUrl: () => Promise<string>
      authenticateGatewaySession: (accessToken: string) => Promise<{ userId: string }>
      clearGatewaySession: () => Promise<void>
      saveModelApiKey: (profileId: string, apiKey: string) => Promise<void>
      hasModelApiKey: (profileId: string) => Promise<boolean>
      getEnvironmentModels: () => Promise<EnvironmentModels>
      loadModelConfig: () => Promise<Partial<SettingsConfig> | null>
      saveModelConfig: (config: SettingsConfig) => Promise<{ saved: boolean }>
      transcribeAudioChunk: (input: { profileId: string; endpoint: string; model: string; language: string; requiresApiKey?: boolean; prompt?: string; filename?: string; contentType?: string; audio: ArrayBuffer }) => Promise<{ text: string; detectedLanguage?: 'zh-TW' | 'en-US' | 'ja-JP' | 'de-DE' }>
      completeText: (input: { requestId?: string; profileId: string; endpoint: string; model: string; temperature?: number; requiresApiKey?: boolean; messages: Array<{ role: 'system' | 'user'; content: string }> }) => Promise<{ text: string }>
      cancelCompleteText: (requestId: string) => Promise<void>
      diarizeAudio: (input: { endpoint: string; model: string; audio: ArrayBuffer; embeddings?: boolean }) => Promise<unknown>
      startPcmRecording: (sampleRate: number) => Promise<{ id: string }>
      appendPcm: (id: string, audio: ArrayBuffer) => Promise<{ bytesWritten: number }>
      finishPcmRecording: (id: string) => Promise<{ audioPath: string }>
      abortPcmRecording: (id: string) => Promise<void>
      readAudio: (audioPath: string) => Promise<ArrayBuffer>
      saveLocalAudio: (key: string, audio: ArrayBuffer) => Promise<{ audioPath: string }>
      deleteLocalAudio: (audioPath: string) => Promise<void>
      saveSession: (input: { name: string; audio?: ArrayBuffer; recordingPath?: string; overwriteAudioPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; summary?: string; segments: unknown[] }) => Promise<{ canceled: boolean; audioPath?: string; directory?: string }>
      transcodeAudio: (input: { audio: ArrayBuffer; target: 'm4a' }) => Promise<ArrayBuffer>
      openSession: () => Promise<{ canceled: boolean; session?: { id: string; title: string; createdAt: string; durationMs: number; source: string; transcript: string; audioKey: string; nativeAudioPath: string; savedToDisk: boolean; summary?: string; segments: unknown[] } }>
      listSessions: () => Promise<Array<{ id: string; title: string; createdAt: string; durationMs: number; source: string; transcript: string; audioKey: string; nativeAudioPath: string; savedToDisk: boolean; segments: unknown[] }>>
      listRecoverableRecordings: () => Promise<Array<{ id: string; path: string; audioPath: string; sampleRate: number; createdAt: string; state: 'active' | 'finished' }>>
      discardRecoverableRecording: (id: string) => Promise<void>
      toggleFloatingCaptions: (visible: boolean) => void
      closeFloatingCaptions: () => void
      toggleFloatingCaptionFullscreen: () => Promise<boolean>
      updateFloatingCaption: (text: string) => void
      onFloatingCaption: (listener: (text: string) => void) => () => void
      onFloatingCaptionClosed: (listener: () => void) => () => void
}
