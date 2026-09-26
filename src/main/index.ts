import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session } from 'electron'
import { basename, isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'
import OpenAI, { toFile } from 'openai'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: join(process.cwd(), '.env') })

const gatewayUrl = (): string => {
  const configured = process.env.S2T_GATEWAY_URL?.trim() ?? ''
  if (!configured) {
    if (app.isPackaged) throw new Error('打包版必須設定 S2T_GATEWAY_URL，並指向外部 HTTPS gateway')
    return ''
  }
  let url: URL
  try { url = new URL(configured) } catch { throw new Error('S2T_GATEWAY_URL 必須是有效的 HTTPS URL') }
  if (url.protocol !== 'https:' && !(is.dev && url.protocol === 'http:')) throw new Error('S2T_GATEWAY_URL 必須使用 HTTPS；僅開發測試可使用 HTTP')
  url.pathname = url.pathname.replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}

let captionWindow: BrowserWindow | null = null
const desktopUsers = new Map<number, string>()
const validUserId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const accountDirectory = (userId: string): string => join(app.getPath('userData'), 'accounts', userId)
const accountSessionsDirectory = (userId: string): string => join(accountDirectory(userId), 'sessions')
const requireDesktopUser = (event: { sender: { id: number } }): string => {
  const userId = desktopUsers.get(event.sender.id)
  if (!userId) throw new Error('請先完成登入驗證')
  return userId
}
type PcmRecording = { userId: string; path: string; stream: WriteStream; sampleRate: number; bytesWritten: number; writes: Promise<void> }
type RecoverableRecording = { id: string; path: string; sampleRate: number; createdAt: string; state: 'active' | 'finished' }
const pcmRecordings = new Map<string, PcmRecording>()
const completedRecordings = new Set<string>()
const availableAudioPaths = new Map<string, string>()
const recoveryManifestUpdates = new Map<string, Promise<void>>()

const recoveryManifestPath = (userId: string): string => join(accountDirectory(userId), 'recording-manifest.json')
const recoveryDirectory = (userId: string): string => join(accountDirectory(userId), 'recoverable-recordings')
const readRecoveryManifest = async (userId: string): Promise<RecoverableRecording[]> => {
  try {
    const value = JSON.parse(await readFile(recoveryManifestPath(userId), 'utf8')) as unknown
    return Array.isArray(value) ? value.flatMap((item): RecoverableRecording[] => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Partial<RecoverableRecording>
      return typeof entry.id === 'string' && typeof entry.path === 'string' && Number.isFinite(entry.sampleRate) &&
        typeof entry.createdAt === 'string' && (entry.state === 'active' || entry.state === 'finished') ? [entry as RecoverableRecording] : []
    }) : []
  } catch { return [] }
}
const writeRecoveryManifest = async (userId: string, entries: RecoverableRecording[]): Promise<void> => {
  const file = recoveryManifestPath(userId)
  await mkdir(join(file, '..'), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 })
  await rename(temporary, file)
}
const updateRecoveryManifest = async (userId: string, update: (entries: RecoverableRecording[]) => RecoverableRecording[]): Promise<void> => {
  const prior = recoveryManifestUpdates.get(userId) ?? Promise.resolve()
  const pending = prior.catch(() => undefined).then(async () => writeRecoveryManifest(userId, update(await readRecoveryManifest(userId))))
  recoveryManifestUpdates.set(userId, pending)
  try { await pending } finally { if (recoveryManifestUpdates.get(userId) === pending) recoveryManifestUpdates.delete(userId) }
}
const pathInside = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate)
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference)
}

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

const secretStorePath = (userId: string): string => join(accountDirectory(userId), 'model-secrets.json')
const modelConfigPath = (userId: string): string => join(accountDirectory(userId), 'models.json')
const validSecretId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id)
const readSecrets = async (userId: string): Promise<Record<string, string>> => {
  try {
    const stored = JSON.parse(await readFile(secretStorePath(userId), 'utf8')) as Record<string, string>
    return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
      try { return [[id, safeStorage.decryptString(Buffer.from(value, 'base64'))]] } catch { return [] }
    }))
  } catch { return {} }
}
const saveSecret = async (userId: string, id: string, value: string): Promise<void> => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('此系統無法使用 Electron 安全儲存區')
  const current = await readSecrets(userId)
  current[id] = value
  const encrypted = Object.fromEntries(Object.entries(current).map(([key, secret]) => [key, safeStorage.encryptString(secret).toString('base64')]))
  await mkdir(accountDirectory(userId), { recursive: true })
  await writeFile(secretStorePath(userId), JSON.stringify(encrypted), { mode: 0o600 })
}
const openAiBaseUrl = (endpoint: string): string => {
  const url = new URL(endpoint)
  url.pathname = url.pathname.replace(/\/audio\/transcriptions\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}
const openAiChatBaseUrl = (endpoint: string): string => {
  const url = new URL(endpoint)
  url.pathname = url.pathname.replace(/\/(audio\/transcriptions|chat\/completions|responses)\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}
const environmentKey = (profileId: string): string | undefined => {
  if (profileId === 'translation') return process.env.S2T_TRANSLATION_API_KEY
  if (profileId === 'summary') return process.env.S2T_SUMMARY_API_KEY
  if (profileId === 'diarization') return process.env.S2T_DIARIZATION_API_KEY
  return process.env.S2T_ASR_API_KEY
}

type StoredModelProfile = { id: string; name: string; endpoint: string; model: string; kind: 'websocket' | 'openai-http'; requiresApiKey?: boolean; capabilities: { asrMode: 'streaming' | 'non-streaming'; vadSource: 'app' | 'server'; timestampPrecision: 'chunk' | 'segment' | 'word'; supportedLanguages: string[]; supportedSampleRates: number[] } }
type StoredModelConfig = {
  theme: 'system' | 'light' | 'dark'; storageLocation: 'local' | 'remote'; sourceLanguage: string; targetLanguage: string; modelProfiles: StoredModelProfile[]; selectedModelId: string
  translationEnabled: boolean; translationStrategy: 'realtime' | 'sentence'; translationLoadStrategy: 'automatic' | 'manual'; translationEndpoint: string; translationModel: string; translationProfiles: Array<{ id: string; name: string; endpoint: string; model: string }>; selectedTranslationModelId: string; summaryEndpoint: string; summaryModel: string; summaryTemplate: string; summaryTemplates: Array<{ id: string; name: string; content: string }>; selectedSummaryTemplateId: string; summaryOutputLanguage: string; summaryIncludeTranslation: boolean; diarizationEndpoint: string; diarizationModel: string; glossary: string
  vadConfig: { minSpeechMs: number; minSilenceMs: number; preRollMs: number; noiseFloorOffsetDb: number }
}
const shortText = (value: unknown, maximum = 500): string => typeof value === 'string' ? value.trim().slice(0, maximum) : ''
const sanitizeModelConfig = (value: unknown): StoredModelConfig => {
  if (!value || typeof value !== 'object') throw new Error('無效的模型設定')
  const input = value as Record<string, unknown>
  const modelProfiles = Array.isArray(input.modelProfiles) ? input.modelProfiles.flatMap((item): StoredModelProfile[] => {
    if (!item || typeof item !== 'object') return []
    const profile = item as Record<string, unknown>
    const id = shortText(profile.id, 100)
    const name = shortText(profile.name, 100)
    const endpoint = shortText(profile.endpoint, 2_000)
    const model = shortText(profile.model, 200)
    const kind = profile.kind === 'openai-http' ? 'openai-http' : 'websocket'
    const capabilityInput = profile.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities as Record<string, unknown> : {}
    const capabilities = {
      asrMode: capabilityInput.asrMode === 'non-streaming' ? 'non-streaming' as const : 'streaming' as const,
      vadSource: capabilityInput.vadSource === 'app' ? 'app' as const : 'server' as const,
      timestampPrecision: capabilityInput.timestampPrecision === 'word' ? 'word' as const : capabilityInput.timestampPrecision === 'segment' ? 'segment' as const : 'chunk' as const,
      // Capability values are an explicit user/provider declaration.  Do not
      // turn an absent value into a made-up compatibility guarantee.
      supportedLanguages: Array.isArray(capabilityInput.supportedLanguages) ? capabilityInput.supportedLanguages.filter((language): language is string => typeof language === 'string' && /^[A-Za-z-]{2,20}$/.test(language)).slice(0, 12) : [],
      supportedSampleRates: Array.isArray(capabilityInput.supportedSampleRates) ? capabilityInput.supportedSampleRates.filter((rate): rate is number => typeof rate === 'number' && Number.isInteger(rate) && rate >= 8_000 && rate <= 192_000).slice(0, 12) : []
    }
    return id && name ? [{ id, name, endpoint, model, kind, requiresApiKey: profile.requiresApiKey !== false, capabilities }] : []
  }).slice(0, 30) : []
  const translationProfiles = Array.isArray(input.translationProfiles) ? input.translationProfiles.flatMap((item): Array<{ id: string; name: string; endpoint: string; model: string }> => {
    if (!item || typeof item !== 'object') return []
    const profile = item as Record<string, unknown>
    const id = shortText(profile.id, 100); const name = shortText(profile.name, 100); const endpoint = shortText(profile.endpoint, 2_000); const model = shortText(profile.model, 200)
    return id && name && endpoint && model ? [{ id, name, endpoint, model }] : []
  }).slice(0, 30) : []
  const summaryTemplates = Array.isArray(input.summaryTemplates) ? input.summaryTemplates.flatMap((item): Array<{ id: string; name: string; content: string }> => {
    if (!item || typeof item !== 'object') return []
    const template = item as Record<string, unknown>
    const id = shortText(template.id, 100); const name = shortText(template.name, 100); const content = shortText(template.content, 20_000)
    return id && name && content ? [{ id, name, content }] : []
  }).slice(0, 50) : []
  const vadInput = input.vadConfig && typeof input.vadConfig === 'object' ? input.vadConfig as Record<string, unknown> : {}
  const boundedNumber = (value: unknown, fallback: number, minimum: number, maximum: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
  return {
    theme: input.theme === 'light' || input.theme === 'dark' ? input.theme : 'system', storageLocation: input.storageLocation === 'remote' ? 'remote' : 'local', sourceLanguage: shortText(input.sourceLanguage, 40), targetLanguage: shortText(input.targetLanguage, 40), modelProfiles,
    selectedModelId: shortText(input.selectedModelId, 100), translationEnabled: input.translationEnabled !== false, translationStrategy: input.translationStrategy === 'sentence' ? 'sentence' : 'realtime', translationLoadStrategy: input.translationLoadStrategy === 'manual' ? 'manual' : 'automatic', translationEndpoint: shortText(input.translationEndpoint, 2_000),
    translationModel: shortText(input.translationModel, 200), translationProfiles, selectedTranslationModelId: shortText(input.selectedTranslationModelId, 100), summaryEndpoint: shortText(input.summaryEndpoint, 2_000),
    summaryModel: shortText(input.summaryModel, 200), summaryTemplate: shortText(input.summaryTemplate, 20_000), summaryTemplates, selectedSummaryTemplateId: shortText(input.selectedSummaryTemplateId, 100), summaryOutputLanguage: shortText(input.summaryOutputLanguage, 40), summaryIncludeTranslation: input.summaryIncludeTranslation === true, diarizationEndpoint: shortText(input.diarizationEndpoint, 2_000), diarizationModel: shortText(input.diarizationModel, 200), glossary: shortText(input.glossary, 20_000),
    vadConfig: { minSpeechMs: boundedNumber(vadInput.minSpeechMs, 120, 20, 1_000), minSilenceMs: boundedNumber(vadInput.minSilenceMs, 500, 100, 5_000), preRollMs: boundedNumber(vadInput.preRollMs, 300, 0, 1_000), noiseFloorOffsetDb: boundedNumber(vadInput.noiseFloorOffsetDb, 12, 3, 30) }
  }
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
    width: 1280,
    height: 620,
    minWidth: 500,
    minHeight: 320,
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
  // `media` alone does not grant getDisplayMedia in Electron. Display capture
  // must be permitted separately or the Renderer never receives the audio
  // track it requested.
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media' || permission === 'display-capture')
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })
  // Windows supports Electron's native loopback source. macOS has no Electron
  // loopback equivalent; macOS 15+ can use its system picker, which is the only
  // supported route for a share-provided audio track without a virtual device.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (process.platform !== 'win32') {
      callback({})
      return
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      const source = sources[0]
      callback(source ? { video: source, audio: 'loopback' } : {})
    } catch {
      callback({})
    }
  }, { useSystemPicker: process.platform === 'darwin' })

  // The packaged renderer is loaded from file://, so relative /api URLs have
  // no gateway to resolve against. Production always uses the configured
  // external HTTPS gateway; an empty value remains available only for local
  // development and smoke testing.
  ipcMain.handle('gateway:url', () => gatewayUrl())
  ipcMain.handle('gateway:authenticate', async (event, accessToken: unknown) => {
    if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('缺少登入權杖')
    const response = await fetch(new URL('/api/auth/session', `${gatewayUrl()}/`), { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) })
    const payload = await response.json().catch(() => null) as { user?: { id?: unknown }; error?: string } | null
    if (!response.ok || !validUserId(payload?.user?.id)) throw new Error(payload?.error || '無法驗證登入身分')
    desktopUsers.set(event.sender.id, payload.user.id)
    event.sender.once('destroyed', () => desktopUsers.delete(event.sender.id))
    return { userId: payload.user.id }
  })
  ipcMain.handle('gateway:clear-session', (event) => { desktopUsers.delete(event.sender.id) })

  ipcMain.handle('model:save-api-key', async (event, input: { profileId: string; apiKey: string }) => {
    if (!validSecretId(input.profileId) || typeof input.apiKey !== 'string' || input.apiKey.trim().length < 8) throw new Error('無效的 API key 設定')
    await saveSecret(requireDesktopUser(event), input.profileId, input.apiKey.trim())
  })
  ipcMain.handle('model:has-api-key', async (event, profileId: string) => {
    if (!validSecretId(profileId)) return false
    return Boolean(environmentKey(profileId) || (await readSecrets(requireDesktopUser(event)))[profileId])
  })
  ipcMain.handle('model:environment-models', () => {
    const service = (kind: 'ASR' | 'TRANSLATION' | 'SUMMARY' | 'DIARIZATION') => {
      const endpoint = process.env[`S2T_${kind}_ENDPOINT`] || ''
      const model = process.env[`S2T_${kind}_MODEL`] || ''
      const apiKey = process.env[`S2T_${kind}_API_KEY`] || ''
      return { endpoint, model, configured: Boolean(endpoint && model && (apiKey || kind === 'DIARIZATION')) }
    }
    return { asr: service('ASR'), translation: service('TRANSLATION'), summary: service('SUMMARY'), diarization: service('DIARIZATION') }
  })
  ipcMain.handle('models:load-config', async (event) => {
    try { return JSON.parse(await readFile(modelConfigPath(requireDesktopUser(event)), 'utf8')) } catch { return null }
  })
  ipcMain.handle('models:save-config', async (event, config: unknown) => {
    const sanitized = sanitizeModelConfig(config)
    const userId = requireDesktopUser(event)
    await mkdir(accountDirectory(userId), { recursive: true })
    await writeFile(modelConfigPath(userId), JSON.stringify(sanitized, null, 2), { mode: 0o600 })
    return { saved: true }
  })
  ipcMain.handle('model:transcribe', async (event, input: { profileId: string; endpoint: string; model: string; language: string; requiresApiKey?: boolean; prompt?: string; filename?: string; contentType?: string; audio: ArrayBuffer }) => {
    if (!validSecretId(input.profileId) || !(input.audio instanceof ArrayBuffer) || input.audio.byteLength === 0 || input.audio.byteLength > 100 * 1024 * 1024) throw new Error('無效的音訊分段')
    const apiKey = environmentKey(input.profileId) || (await readSecrets(requireDesktopUser(event)))[input.profileId]
    if (!apiKey && input.requiresApiKey !== false) throw new Error('請先在設定中儲存此模型的 API key')
    let baseURL: string
    try { baseURL = openAiBaseUrl(input.endpoint) } catch { throw new Error('無效的轉錄 API 位址') }
    const client = new OpenAI({ apiKey: apiKey || 'not-required', baseURL, timeout: 20_000, maxRetries: 1 })
    try {
      const result = await client.audio.transcriptions.create({
        file: await toFile(Buffer.from(input.audio), input.filename || 'live-chunk.wav', { type: input.contentType || 'audio/wav' }),
        model: input.model,
        ...(input.language ? { language: input.language } : {}),
        ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {})
      })
      return { text: result.text ?? '' }
    } catch (error) {
      throw new Error(error instanceof Error ? `模型轉錄失敗：${error.message}` : '模型轉錄失敗')
    }
  })
  ipcMain.handle('model:complete', async (event, input: { profileId: string; endpoint: string; model: string; messages: Array<{ role: 'system' | 'user'; content: string }> }) => {
    if (!validSecretId(input.profileId) || !Array.isArray(input.messages) || !input.model.trim()) throw new Error('無效的文字模型請求')
    const apiKey = environmentKey(input.profileId) || (await readSecrets(requireDesktopUser(event)))[input.profileId]
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
  ipcMain.handle('model:diarize', async (event, input: { endpoint: string; model: string; audio: ArrayBuffer }) => {
    if (!(input.audio instanceof ArrayBuffer) || !input.audio.byteLength || input.audio.byteLength > 500 * 1024 * 1024) throw new Error('無效的講者分離音檔')
    let endpoint: URL
    try { endpoint = new URL(input.endpoint) } catch { throw new Error('無效的講者分離 API 位址') }
    const isLoopbackSherpa = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && endpoint.pathname === '/api/diarizations'
    const apiKey = environmentKey('diarization') || (await readSecrets(requireDesktopUser(event))).diarization
    if (!apiKey && !isLoopbackSherpa) throw new Error('請先在設定中儲存講者分離 API key')
    try {
      const form = new FormData()
      form.set('model', input.model)
      form.set('file', new Blob([input.audio], { type: 'audio/wav' }), 'recording.wav')
      const response = await fetch(endpoint, isLoopbackSherpa
        ? { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.from(input.audio), signal: AbortSignal.timeout(120_000) }
        : { method: 'POST', headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: form, signal: AbortSignal.timeout(120_000) })
      const body = await response.text()
      let payload: unknown
      try { payload = JSON.parse(body) } catch { throw new Error(body.trim() ? `服務回傳非 JSON（HTTP ${response.status}）` : `服務沒有回傳資料（HTTP ${response.status}）`) }
      if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'error' in payload ? String((payload as { error: unknown }).error) : `HTTP ${response.status}`)
      return payload
    } catch (error) {
      throw new Error(error instanceof Error ? `講者分離失敗：${error.message}` : '講者分離失敗')
    }
  })

  ipcMain.handle('recording:start', async (event, sampleRate: number) => {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new Error('無效的錄音取樣率')
    const userId = requireDesktopUser(event)
    const directory = recoveryDirectory(userId)
    await mkdir(directory, { recursive: true })
    const id = randomUUID()
    const path = join(directory, `${id}.wav.part`)
    const stream = createWriteStream(path)
    const recording: PcmRecording = { userId, path, stream, sampleRate, bytesWritten: 0, writes: Promise.resolve() }
    recording.writes = new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.write(wavHeader(sampleRate, 0), (error) => error ? reject(error) : resolve())
    })
    pcmRecordings.set(id, recording)
    await recording.writes
    await updateRecoveryManifest(userId, (entries) => [...entries.filter((entry) => entry.id !== id), { id, path, sampleRate, createdAt: new Date().toISOString(), state: 'active' }])
    return { id }
  })

  ipcMain.handle('recording:append', async (event, input: { id: string; audio: ArrayBuffer }) => {
    const recording = pcmRecordings.get(input.id)
    if (!recording || recording.userId !== requireDesktopUser(event) || !(input.audio instanceof ArrayBuffer)) throw new Error('找不到進行中的錄音')
    const chunk = Buffer.from(input.audio)
    if (chunk.length === 0) return { bytesWritten: recording.bytesWritten }
    if (chunk.length > 1024 * 1024) throw new Error('錄音寫入分段過大')
    recording.bytesWritten += chunk.length
    recording.writes = recording.writes.then(() => new Promise<void>((resolve, reject) => {
      recording.stream.write(chunk, (error) => error ? reject(error) : resolve())
    }))
    await recording.writes
    return { bytesWritten: recording.bytesWritten }
  })

  ipcMain.handle('recording:finish', async (event, id: string) => {
    const recording = pcmRecordings.get(id)
    if (!recording || recording.userId !== requireDesktopUser(event)) throw new Error('找不到進行中的錄音')
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
      availableAudioPaths.set(recording.path, recording.userId)
      await updateRecoveryManifest(recording.userId, (entries) => entries.map((entry) => entry.id === id ? { ...entry, state: 'finished' } : entry))
      return { audioPath: recording.path }
    } finally {
      pcmRecordings.delete(id)
    }
  })

  ipcMain.handle('recording:abort', async (event, id: string) => {
    const recording = pcmRecordings.get(id)
    if (!recording || recording.userId !== requireDesktopUser(event)) return
    pcmRecordings.delete(id)
    recording.stream.destroy()
    await rm(recording.path, { force: true })
    await updateRecoveryManifest(recording.userId, (entries) => entries.filter((entry) => entry.id !== id))
  })

  ipcMain.handle('session:save', async (event, input: {
    name: string; audio?: ArrayBuffer; recordingPath?: string; transcript: string; createdAt: string; durationMs: number; source: string; summary?: string; segments: unknown[]
  }) => {
    const userId = requireDesktopUser(event)
    const directory = join(accountSessionsDirectory(userId), `s2t-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    const audioPath = join(directory, 'audio.wav')
    if (input.recordingPath && availableAudioPaths.get(input.recordingPath) === userId) {
      await copyFile(input.recordingPath, audioPath)
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
      source: input.source, summary: input.summary, audioFile: 'audio.wav', transcriptFile: 'transcript.jsonl'
    }, null, 2), 'utf8')
    if (input.recordingPath && completedRecordings.has(input.recordingPath)) {
      await rm(input.recordingPath, { force: true })
      completedRecordings.delete(input.recordingPath)
      availableAudioPaths.delete(input.recordingPath)
      await updateRecoveryManifest(userId, (entries) => entries.filter((entry) => entry.path !== input.recordingPath))
    }
    availableAudioPaths.set(audioPath, userId)
    return { canceled: false, audioPath, directory }
  })

  ipcMain.handle('audio:read', async (event, audioPath: string) => {
    if (typeof audioPath !== 'string' || availableAudioPaths.get(audioPath) !== requireDesktopUser(event)) throw new Error('無法讀取此音檔')
    const audio = await readFile(audioPath)
    return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
  })

  ipcMain.handle('session:open', async (event) => {
    const userId = requireDesktopUser(event)
    const sessionsRoot = accountSessionsDirectory(userId)
    await mkdir(sessionsRoot, { recursive: true })
    const result = await dialog.showOpenDialog({ title: '開啟已保存工作階段', defaultPath: sessionsRoot, properties: ['openDirectory'] })
    const directory = result.filePaths[0]
    if (result.canceled || !directory) return { canceled: true }
    const root = await realpath(directory)
    const accountRoot = await realpath(sessionsRoot)
    if (!pathInside(accountRoot, root)) throw new Error('只能開啟目前登入帳號保存的工作階段')
    const metadata = JSON.parse(await readFile(join(root, 'session.json'), 'utf8')) as Record<string, unknown>
    if (metadata.version !== 1 || typeof metadata.audioFile !== 'string' || basename(metadata.audioFile) !== metadata.audioFile) throw new Error('不是有效的 S2T UI 工作階段')
    const audioPath = await realpath(join(root, metadata.audioFile))
    if (!pathInside(root, audioPath)) throw new Error('工作階段音檔位置無效')
    const transcriptFile = typeof metadata.transcriptFile === 'string' && basename(metadata.transcriptFile) === metadata.transcriptFile ? metadata.transcriptFile : 'transcript.jsonl'
    const lines = (await readFile(join(root, transcriptFile), 'utf8')).split('\n').filter(Boolean)
    const segments = lines.flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    availableAudioPaths.set(audioPath, userId)
    return { canceled: false, session: {
      id: `disk-${randomUUID()}`, title: typeof metadata.name === 'string' ? metadata.name : '已保存工作階段',
      createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : new Date().toISOString(),
      durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : 0,
      source: typeof metadata.source === 'string' ? metadata.source : '已保存工作階段', transcript: await readFile(join(root, 'transcript.txt'), 'utf8'),
      audioKey: '', nativeAudioPath: audioPath, savedToDisk: true, summary: typeof metadata.summary === 'string' ? metadata.summary : undefined, segments
    } }
  })
  ipcMain.handle('recording:recoverable', async (event) => {
    const userId = requireDesktopUser(event)
    const entries = await readRecoveryManifest(userId)
    const recovered: Array<RecoverableRecording & { audioPath: string }> = []
    for (const entry of entries) {
      try {
        const info = await stat(entry.path)
        if (info.size <= 44) continue
        const file = await open(entry.path, 'r+')
        try { await file.write(wavHeader(entry.sampleRate, info.size - 44), 0) } finally { await file.close() }
        availableAudioPaths.set(entry.path, userId)
        recovered.push({ ...entry, audioPath: entry.path })
      } catch { /* stale manifests are omitted below */ }
    }
    await updateRecoveryManifest(userId, () => recovered.map(({ audioPath: _audioPath, ...entry }) => ({ ...entry, state: 'finished' })))
    return recovered
  })
  ipcMain.handle('recording:discard-recoverable', async (event, id: string) => {
    const userId = requireDesktopUser(event)
    const entries = await readRecoveryManifest(userId)
    const target = entries.find((entry) => entry.id === id)
    if (target) await rm(target.path, { force: true })
    await updateRecoveryManifest(userId, (current) => current.filter((entry) => entry.id !== id))
  })

  ipcMain.on('captions:toggle-floating', (_event, visible: boolean) => {
    if (visible) showCaptionWindow()
    else captionWindow?.hide()
  })
  ipcMain.handle('captions:toggle-floating-fullscreen', () => {
    if (!captionWindow || captionWindow.isDestroyed()) return false
    captionWindow.setFullScreen(!captionWindow.isFullScreen())
    return captionWindow.isFullScreen()
  })
  ipcMain.on('captions:close-floating', () => {
    captionWindow?.hide()
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== captionWindow) window.webContents.send('captions:floating-closed')
    }
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
