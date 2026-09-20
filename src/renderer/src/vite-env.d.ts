/// <reference types="vite/client" />

declare global {
  interface Window {
    s2t?: {
      saveSession: (input: { name: string; audio: ArrayBuffer; transcript: string }) => Promise<{ canceled: boolean; audioPath?: string }>
    }
  }
}

export {}
