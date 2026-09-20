import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('s2t', {
  startPcmRecording: (sampleRate: number) => ipcRenderer.invoke('recording:start', sampleRate),
  appendPcm: (id: string, audio: ArrayBuffer) => ipcRenderer.send('recording:append', { id, audio }),
  finishPcmRecording: (id: string) => ipcRenderer.invoke('recording:finish', id),
  abortPcmRecording: (id: string) => ipcRenderer.invoke('recording:abort', id),
  saveSession: (input: { name: string; audio?: ArrayBuffer; recordingPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; segments: unknown[] }) => ipcRenderer.invoke('session:save', input),
  toggleFloatingCaptions: (visible: boolean) => ipcRenderer.send('captions:toggle-floating', visible),
  updateFloatingCaption: (text: string) => ipcRenderer.send('captions:update-floating', text),
  onFloatingCaption: (listener: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string): void => listener(text)
    ipcRenderer.on('captions:floating-update', handler)
    return () => ipcRenderer.removeListener('captions:floating-update', handler)
  }
})
