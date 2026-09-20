import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: 'S2T UI',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })

  ipcMain.handle('session:save', async (_event, input: { name: string; audio: ArrayBuffer; transcript: string }) => {
    const result = await dialog.showSaveDialog({
      title: '儲存錄音',
      defaultPath: `${input.name || 'recording'}.webm`,
      filters: [{ name: 'WebM audio', extensions: ['webm'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    await writeFile(result.filePath, Buffer.from(input.audio))
    await writeFile(result.filePath.replace(/\.webm$/i, '.txt'), input.transcript, 'utf8')
    return { canceled: false, audioPath: result.filePath }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
