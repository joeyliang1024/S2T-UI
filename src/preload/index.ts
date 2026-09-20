import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('s2t', {
  saveSession: (input: { name: string; audio: ArrayBuffer; transcript: string }) => ipcRenderer.invoke('session:save', input),
  toggleFloatingCaptions: (visible: boolean) => ipcRenderer.send('captions:toggle-floating', visible),
  updateFloatingCaption: (text: string) => ipcRenderer.send('captions:update-floating', text),
  onFloatingCaption: (listener: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string): void => listener(text)
    ipcRenderer.on('captions:floating-update', handler)
    return () => ipcRenderer.removeListener('captions:floating-update', handler)
  }
})
