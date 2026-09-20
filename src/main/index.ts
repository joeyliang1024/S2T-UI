import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'

let captionWindow: BrowserWindow | null = null

const loadRenderer = (window: BrowserWindow, fragment = ''): void => {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${fragment}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: fragment.replace(/^#/, '') })
  }
}

const showCaptionWindow = (): void => {
  if (captionWindow && !captionWindow.isDestroyed()) {
    captionWindow.showInactive()
    return
  }
  captionWindow = new BrowserWindow({
    width: 760,
    height: 164,
    minWidth: 360,
    minHeight: 104,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    title: 'S2T UI 浮動字幕',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  captionWindow.setAlwaysOnTop(true, 'floating')
  captionWindow.on('closed', () => { captionWindow = null })
  loadRenderer(captionWindow, '#floating')
}

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
  loadRenderer(window)
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })

  ipcMain.handle('session:save', async (_event, input: {
    name: string; audio: ArrayBuffer; transcript: string; createdAt: string; durationMs: number; source: string; segments: unknown[]
  }) => {
    const result = await dialog.showOpenDialog({
      title: '選擇工作階段保存位置',
      properties: ['openDirectory', 'createDirectory']
    })
    const parentDirectory = result.filePaths[0]
    if (result.canceled || !parentDirectory) return { canceled: true }

    const directory = join(parentDirectory, input.name || 'recording')
    await mkdir(directory, { recursive: true })
    const audioPath = join(directory, 'audio.wav')
    await writeFile(audioPath, Buffer.from(input.audio))
    await writeFile(join(directory, 'transcript.txt'), input.transcript, 'utf8')
    await writeFile(join(directory, 'transcript.jsonl'), input.segments.map((segment) => JSON.stringify(segment)).join('\n') + (input.segments.length ? '\n' : ''), 'utf8')
    await writeFile(join(directory, 'events.jsonl'), '', 'utf8')
    await writeFile(join(directory, 'session.json'), JSON.stringify({
      version: 1, name: input.name, createdAt: input.createdAt, durationMs: input.durationMs,
      source: input.source, audioFile: 'audio.wav', transcriptFile: 'transcript.jsonl'
    }, null, 2), 'utf8')
    return { canceled: false, audioPath, directory }
  })

  ipcMain.on('captions:toggle-floating', (_event, visible: boolean) => {
    if (visible) showCaptionWindow()
    else captionWindow?.hide()
  })
  ipcMain.on('captions:update-floating', (_event, text: string) => {
    captionWindow?.webContents.send('captions:floating-update', text)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
