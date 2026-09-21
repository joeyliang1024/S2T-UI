import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'
import OpenAI, { toFile } from 'openai'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: join(process.cwd(), '.env') })

let captionWindow: BrowserWindow | null = null
type PcmRecording = { path: string; stream: WriteStream; sampleRate: number; bytesWritten: number; writes: Promise<void> }
const pcmRecordings = new Map<string, PcmRecording>()
const completedRecordings = new Set<string>()
const availableAudioPaths = new Set<string>()

const wavHeader = (sampleRate: number, dataBytes: number): Buffer => {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

const waitForStreamEnd = (stream: WriteStream): Promise<void> => new Promise((resolve, reject) => {
  stream.once('finish', resolve)
  stream.once('error', reject)
  stream.end()
})

const secretStorePath = (): string => join(app.getPath('userData'), 'model-secrets.json')
const modelConfigPath = (): string => join(app.getPath('userData'), 'models.json')
const validSecretId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id)
const readSecrets = async (): Promise<Record<string, string>> => {
  try {
    const stored = JSON.parse(await readFile(secretStorePath(), 'utf8')) as Record<string, string>
    return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
      try { return [[id, safeStorage.decryptString(Buffer.from(value, 'base64'))]] } catch { return [] }
    }))
  } catch { return {} }
}
const saveSecret = async (id: string, value: string): Promise<void> => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('此系統無法使用 Electron 安全儲存區')
  const current = await readSecrets()
  current[id] = value
  const encrypted = Object.fromEntries(Object.entries(current).map(([key, secret]) => [key, safeStorage.encryptString(secret).toString('base64')]))
  await writeFile(secretStorePath(), JSON.stringify(encrypted), { mode: 0o600 })
}
const openAiBaseUrl = (endpoint: string): string => {
  const url = new URL(endpoint)
  url.pathname = url.pathname.replace(/\/audio\/transcriptions\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}
const openAiChatBaseUrl = (endpoint: string): string => {
  const url = new URL(endpoint)
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}
const environmentKey = (profileId: string): string | undefined => {
  if (profileId === 'translation') return process.env.S2T_TRANSLATION_API_KEY
  if (profileId === 'summary') return process.env.S2T_SUMMARY_API_KEY
  return process.env.S2T_ASR_API_KEY
}

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

  ipcMain.handle('model:save-api-key', async (_event, input: { profileId: string; apiKey: string }) => {
    if (!validSecretId(input.profileId) || typeof input.apiKey !== 'string' || input.apiKey.trim().length < 8) throw new Error('無效的 API key 設定')
    await saveSecret(input.profileId, input.apiKey.trim())
  })
  ipcMain.handle('model:has-api-key', async (_event, profileId: string) => {
    if (!validSecretId(profileId)) return false
    return Boolean(environmentKey(profileId) || (await readSecrets())[profileId])
  })
  ipcMain.handle('model:environment-asr', () => ({
    endpoint: process.env.S2T_ASR_ENDPOINT ?? '',
    model: process.env.S2T_ASR_MODEL ?? '',
    configured: Boolean(process.env.S2T_ASR_API_KEY && process.env.S2T_ASR_ENDPOINT && process.env.S2T_ASR_MODEL)
  }))
  ipcMain.handle('models:load-config', async () => {
    try { return JSON.parse(await readFile(modelConfigPath(), 'utf8')) } catch { return null }
  })
  ipcMain.handle('models:save-config', async (_event, config: unknown) => {
    if (!config || typeof config !== 'object') throw new Error('無效的模型設定')
    await writeFile(modelConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
    return { saved: true }
  })
  ipcMain.handle('model:transcribe', async (_event, input: { profileId: string; endpoint: string; model: string; language: string; prompt?: string; filename?: string; contentType?: string; audio: ArrayBuffer }) => {
    if (!validSecretId(input.profileId) || !(input.audio instanceof ArrayBuffer) || input.audio.byteLength === 0 || input.audio.byteLength > 100 * 1024 * 1024) throw new Error('無效的音訊分段')
    const apiKey = environmentKey(input.profileId) || (await readSecrets())[input.profileId]
    if (!apiKey) throw new Error('請先在設定中儲存此模型的 API key')
    let baseURL: string
    try { baseURL = openAiBaseUrl(input.endpoint) } catch { throw new Error('無效的轉錄 API 位址') }
    const client = new OpenAI({ apiKey, baseURL, timeout: 20_000, maxRetries: 1 })
    try {
      const result = await client.audio.transcriptions.create({
        file: await toFile(Buffer.from(input.audio), input.filename || 'live-chunk.wav', { type: input.contentType || 'audio/wav' }),
        model: input.model,
        language: input.language,
        ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {})
      })
      return { text: result.text ?? '' }
    } catch (error) {
      throw new Error(error instanceof Error ? `模型轉錄失敗：${error.message}` : '模型轉錄失敗')
    }
  })
  ipcMain.handle('model:complete', async (_event, input: { profileId: string; endpoint: string; model: string; messages: Array<{ role: 'system' | 'user'; content: string }> }) => {
    if (!validSecretId(input.profileId) || !Array.isArray(input.messages) || !input.model.trim()) throw new Error('無效的文字模型請求')
    const apiKey = environmentKey(input.profileId) || (await readSecrets())[input.profileId]
    if (!apiKey) throw new Error('請先在設定中儲存此服務的 API key')
    let baseURL: string
    try { baseURL = openAiChatBaseUrl(input.endpoint) } catch { throw new Error('無效的文字 API 位址') }
    const client = new OpenAI({ apiKey, baseURL, timeout: 30_000, maxRetries: 1 })
    try {
      const result = await client.chat.completions.create({ model: input.model, messages: input.messages, temperature: 0.2 })
      return { text: result.choices[0]?.message.content?.trim() ?? '' }
    } catch (error) {
      throw new Error(error instanceof Error ? `文字模型請求失敗：${error.message}` : '文字模型請求失敗')
    }
  })

  ipcMain.handle('recording:start', async (_event, sampleRate: number) => {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new Error('無效的錄音取樣率')
    const directory = join(app.getPath('temp'), 's2t-ui-recordings')
    await mkdir(directory, { recursive: true })
    const id = randomUUID()
    const path = join(directory, `${id}.wav.part`)
    const stream = createWriteStream(path)
    const recording: PcmRecording = { path, stream, sampleRate, bytesWritten: 0, writes: Promise.resolve() }
    recording.writes = new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.write(wavHeader(sampleRate, 0), (error) => error ? reject(error) : resolve())
    })
    pcmRecordings.set(id, recording)
    await recording.writes
    return { id }
  })

  ipcMain.on('recording:append', (_event, input: { id: string; audio: ArrayBuffer }) => {
    const recording = pcmRecordings.get(input.id)
    if (!recording || !(input.audio instanceof ArrayBuffer)) return
    const chunk = Buffer.from(input.audio)
    if (chunk.length === 0) return
    recording.bytesWritten += chunk.length
    recording.writes = recording.writes.then(() => new Promise<void>((resolve, reject) => {
      recording.stream.write(chunk, (error) => error ? reject(error) : resolve())
    }))
  })

  ipcMain.handle('recording:finish', async (_event, id: string) => {
    const recording = pcmRecordings.get(id)
    if (!recording) throw new Error('找不到進行中的錄音')
    try {
      await recording.writes
      await waitForStreamEnd(recording.stream)
      const file = await open(recording.path, 'r+')
      try {
        await file.write(wavHeader(recording.sampleRate, recording.bytesWritten), 0)
      } finally {
        await file.close()
      }
      completedRecordings.add(recording.path)
      availableAudioPaths.add(recording.path)
      return { audioPath: recording.path }
    } finally {
      pcmRecordings.delete(id)
    }
  })

  ipcMain.handle('recording:abort', async (_event, id: string) => {
    const recording = pcmRecordings.get(id)
    if (!recording) return
    pcmRecordings.delete(id)
    recording.stream.destroy()
    await rm(recording.path, { force: true })
  })

  ipcMain.handle('session:save', async (_event, input: {
    name: string; audio?: ArrayBuffer; recordingPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; segments: unknown[]
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
    if (input.recordingPath && completedRecordings.has(input.recordingPath)) {
      await copyFile(input.recordingPath, audioPath)
      await rm(input.recordingPath, { force: true })
      completedRecordings.delete(input.recordingPath)
      availableAudioPaths.delete(input.recordingPath)
    } else if (input.audio) {
      await writeFile(audioPath, Buffer.from(input.audio))
    } else {
      throw new Error('沒有可儲存的音訊資料')
    }
    await writeFile(join(directory, 'transcript.txt'), input.transcript, 'utf8')
    await writeFile(join(directory, 'transcript.jsonl'), input.segments.map((segment) => JSON.stringify(segment)).join('\n') + (input.segments.length ? '\n' : ''), 'utf8')
    await writeFile(join(directory, 'events.jsonl'), '', 'utf8')
    await writeFile(join(directory, 'session.json'), JSON.stringify({
      version: 1, name: input.name, createdAt: input.createdAt, durationMs: input.durationMs,
      source: input.source, audioFile: 'audio.wav', transcriptFile: 'transcript.jsonl'
    }, null, 2), 'utf8')
    availableAudioPaths.add(audioPath)
    return { canceled: false, audioPath, directory }
  })

  ipcMain.handle('audio:read', async (_event, audioPath: string) => {
    if (typeof audioPath !== 'string' || !availableAudioPaths.has(audioPath)) throw new Error('無法讀取此音檔')
    const audio = await readFile(audioPath)
    return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
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
