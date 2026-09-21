export {}

declare global {
  interface Window {
    s2t?: {
      saveModelApiKey: (profileId: string, apiKey: string) => Promise<void>
      hasModelApiKey: (profileId: string) => Promise<boolean>
      transcribeAudioChunk: (input: { profileId: string; endpoint: string; model: string; language: string; audio: ArrayBuffer }) => Promise<{ text: string }>
      startPcmRecording: (sampleRate: number) => Promise<{ id: string }>
      appendPcm: (id: string, audio: ArrayBuffer) => void
      finishPcmRecording: (id: string) => Promise<{ audioPath: string }>
      abortPcmRecording: (id: string) => Promise<void>
      saveSession: (input: { name: string; audio?: ArrayBuffer; recordingPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; segments: unknown[] }) => Promise<{ canceled: boolean; audioPath?: string; directory?: string }>
      toggleFloatingCaptions: (visible: boolean) => void
      updateFloatingCaption: (text: string) => void
      onFloatingCaption: (listener: (text: string) => void) => () => void
    }
  }
}
