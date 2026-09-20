/// <reference types="vite/client" />

declare global {
  interface Window {
    s2t?: {
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

export {}
