import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('s2t', {
  getGatewayUrl: () => ipcRenderer.invoke('gateway:url'),
  authenticateGatewaySession: (accessToken: string) => ipcRenderer.invoke('gateway:authenticate', accessToken),
  clearGatewaySession: () => ipcRenderer.invoke('gateway:clear-session'),
  saveModelApiKey: (profileId: string, apiKey: string) => ipcRenderer.invoke('model:save-api-key', { profileId, apiKey }),
  hasModelApiKey: (profileId: string) => ipcRenderer.invoke('model:has-api-key', profileId),
  getEnvironmentModels: () => ipcRenderer.invoke('model:environment-models'),
  loadModelConfig: () => ipcRenderer.invoke('models:load-config'),
  saveModelConfig: (config: unknown) => ipcRenderer.invoke('models:save-config', config),
  transcribeAudioChunk: (input: { profileId: string; endpoint: string; model: string; language: string; requiresApiKey?: boolean; prompt?: string; filename?: string; contentType?: string; audio: ArrayBuffer }) => ipcRenderer.invoke('model:transcribe', input),
  completeText: (input: { profileId: string; endpoint: string; model: string; messages: Array<{ role: 'system' | 'user'; content: string }> }) => ipcRenderer.invoke('model:complete', input),
  diarizeAudio: (input: { endpoint: string; model: string; audio: ArrayBuffer }) => ipcRenderer.invoke('model:diarize', input),
  startPcmRecording: (sampleRate: number) => ipcRenderer.invoke('recording:start', sampleRate),
  appendPcm: (id: string, audio: ArrayBuffer) => ipcRenderer.invoke('recording:append', { id, audio }),
  finishPcmRecording: (id: string) => ipcRenderer.invoke('recording:finish', id),
  abortPcmRecording: (id: string) => ipcRenderer.invoke('recording:abort', id),
  readAudio: (audioPath: string) => ipcRenderer.invoke('audio:read', audioPath),
  saveSession: (input: { name: string; audio?: ArrayBuffer; recordingPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; summary?: string; segments: unknown[] }) => ipcRenderer.invoke('session:save', input),
  openSession: () => ipcRenderer.invoke('session:open'),
  listRecoverableRecordings: () => ipcRenderer.invoke('recording:recoverable'),
  discardRecoverableRecording: (id: string) => ipcRenderer.invoke('recording:discard-recoverable', id),
  toggleFloatingCaptions: (visible: boolean) => ipcRenderer.send('captions:toggle-floating', visible),
  closeFloatingCaptions: () => ipcRenderer.send('captions:close-floating'),
  toggleFloatingCaptionFullscreen: () => ipcRenderer.invoke('captions:toggle-floating-fullscreen'),
  updateFloatingCaption: (text: string) => ipcRenderer.send('captions:update-floating', text),
  onFloatingCaption: (listener: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string): void => listener(text)
    ipcRenderer.on('captions:floating-update', handler)
    return () => ipcRenderer.removeListener('captions:floating-update', handler)
  },
  onFloatingCaptionClosed: (listener: () => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('captions:floating-closed', handler)
    return () => ipcRenderer.removeListener('captions:floating-closed', handler)
  }
})
