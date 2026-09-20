import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('s2t', {
  saveSession: (input: { name: string; audio: ArrayBuffer; transcript: string }) => ipcRenderer.invoke('session:save', input)
})
