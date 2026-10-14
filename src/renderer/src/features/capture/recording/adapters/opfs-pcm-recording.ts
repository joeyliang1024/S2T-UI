import type { LiveTranscriptDraft } from '../../../../../../shared/contracts/sessions'
import { validateRecoveryEntry, type RecordingRecoveryEntry } from '../recovery-manifest'
import { activeTranslate } from '../../../../shared/i18n'

type OpfsDirectory = { getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsDirectory>; getFileHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsFile>; removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>; entries: () => AsyncIterableIterator<[string, unknown]> }
type OpfsFile = { createWritable: () => Promise<OpfsWritable>; getFile: () => Promise<File> }
type OpfsWritable = { write: (data: unknown) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }
const missing = (error: unknown): boolean => error instanceof DOMException && error.name === 'NotFoundError'
const validate = (id: string, sampleRate: number): void => {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 0x7fffffff) throw new Error('Invalid PCM recovery context')
}
const rootDirectory = async (): Promise<OpfsDirectory | null> => {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<OpfsDirectory> }
  return storage.getDirectory ? (await storage.getDirectory()).getDirectoryHandle('s2t-ui-recordings', { create: true }) : null
}

const leaseName = (id: string): string => `s2t-pcm-capture:${id}`
const acquireLease = async (id: string): Promise<(() => void) | undefined> => {
  if (!navigator.locks) return undefined
  return new Promise((resolve, reject) => {
    void navigator.locks.request(leaseName(id), { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('Recording is active in another context')); return }
      await new Promise<void>(release => resolve(release))
    }).catch(reject)
  })
}

const header = (sampleRate: number, dataBytes: number): Uint8Array => {
  const bytes = new Uint8Array(44); const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, dataBytes, true)
  return bytes
}

const writeCommitted = async (file: OpfsFile, bytes: ArrayBuffer | string): Promise<void> => {
  const writer = await file.createWritable()
  try { await writer.write(bytes); await writer.close() }
  catch (error) { await writer.abort?.().catch(() => undefined); throw error }
}
const readChunks = async (directory: OpfsDirectory, sampleRate: number): Promise<Blob | null> => {
  const names: string[] = []
  for await (const [name] of directory.entries()) if (/^\d{10}\.pcm$/.test(name)) names.push(name)
  names.sort()
  const files: File[] = []; let bytes = 0
  for (const [index, name] of names.entries()) {
    // A missing chunk cannot be papered over by joining later audio onto the prefix.
    if (name !== `${String(index).padStart(10, '0')}.pcm`) throw new Error('PCM recovery chunk sequence is damaged')
    const file = await (await directory.getFileHandle(name)).getFile()
    if (!file.size && index === names.length - 1) break // createFile succeeded but its uncommitted writer did not close.
    if (!file.size || file.size % 2) throw new Error('PCM recovery chunk is incomplete')
    bytes += file.size
    if (bytes > 0xffffffff - 36) throw new Error('PCM recovery exceeds WAV size limit')
    files.push(file)
  }
  return files.length ? new Blob([header(sampleRate, bytes).buffer as ArrayBuffer, ...files], { type: 'audio/wav' }) : null
}

/** Each accepted append closes its own file: OPFS write alone is not a durable commit. */
export class OpfsPcmRecording {
  private pending = Promise.resolve()
  private metadataPending = Promise.resolve()
  private index = 0
  private dataBytes = 0
  private closed = false
  private finished?: Promise<Blob>
  private constructor(private readonly root: OpfsDirectory, private readonly name: string, private readonly directory: OpfsDirectory, private readonly sampleRate: number, private recovery?: RecordingRecoveryEntry, private releaseLease?: () => void) {}

  static async create(id: string, sampleRate: number, context?: { ownerId: string; draft: LiveTranscriptDraft; captureOffsetMs?: number }): Promise<OpfsPcmRecording | null> {
    validate(id, sampleRate)
    const root = await rootDirectory()
    if (!root) return null
    const releaseLease = await acquireLease(id)
    try {
    const name = `${id}.pcm`, directory = await root.getDirectoryHandle(name, { create: true })
    // Refuse to overwrite an existing recovery source, including a partially initialized one.
    for await (const _entry of directory.entries()) throw new Error('PCM recording already exists')
    await writeCommitted(await directory.getFileHandle('metadata.json', { create: true }), JSON.stringify({ version: 1, sampleRate }))
    const recovery = context ? validateRecoveryEntry({ version: 1, ownerId: context.ownerId, recordingId: id, captureOffsetMs: context.captureOffsetMs, draft: structuredClone(context.draft) }, id) : undefined
    if (recovery && recovery.draft.sampleRate !== sampleRate) throw new Error('Recording recovery sample rate mismatch')
    if (recovery) await writeCommitted(await directory.getFileHandle('recovery.json', { create: true }), JSON.stringify(recovery))
    return new OpfsPcmRecording(root, name, directory, sampleRate, recovery, releaseLease)
    } catch (error) { releaseLease?.(); throw error }
  }

  static async isActive(id: string): Promise<boolean> {
    return Boolean((await navigator.locks?.query())?.held?.some(lock => lock.name === leaseName(id)))
  }

  static async listRecoveries(ownerId: string, onError?: (error: unknown) => void): Promise<RecordingRecoveryEntry[]> {
    const root = await rootDirectory()
    if (!root) return []
    const records: RecordingRecoveryEntry[] = []
    for await (const [name] of root.entries()) {
      if (!/^[A-Za-z0-9_-]{1,160}\.pcm$/.test(name) || await OpfsPcmRecording.isActive(name.slice(0, -4))) continue
      try {
        const directory = await root.getDirectoryHandle(name)
        const value = JSON.parse(await (await (await directory.getFileHandle('recovery.json')).getFile()).text()) as { ownerId?: unknown }
        if (value?.ownerId === ownerId) records.push(validateRecoveryEntry(value, name.slice(0, -4)))
      } catch (error) { if (!missing(error)) { if (onError) onError(error); else throw error } }
    }
    return records.sort((a, b) => b.draft.startedAt.localeCompare(a.draft.startedAt))
  }

  saveRecoveryDraft(draft: LiveTranscriptDraft): Promise<void> {
    const accepted = structuredClone(draft)
    return this.updateRecovery(current => {
      if (current.draft.id !== accepted.id || accepted.sampleRate !== this.sampleRate) throw new Error('Recording recovery context changed')
      return { ...current, draft: accepted }
    })
  }
  setRecoveryTarget(target: NonNullable<RecordingRecoveryEntry['target']>): Promise<void> {
    const accepted = structuredClone(target)
    return this.updateRecovery(current => ({ ...current, target: accepted }))
  }
  private updateRecovery(update: (current: RecordingRecoveryEntry) => RecordingRecoveryEntry): Promise<void> {
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    // Metadata uses its own sequence so a failed checkpoint does not poison accepted audio writes.
    const operation = this.metadataPending.then(async () => {
      if (!this.recovery) throw new Error('Recording has no owned recovery context')
      const next = validateRecoveryEntry(update(this.recovery), this.name.slice(0, -4))
      await writeCommitted(await this.directory.getFileHandle('recovery.json', { create: true }), JSON.stringify(next))
      this.recovery = next
    })
    this.metadataPending = operation.catch(() => undefined)
    return operation
  }

  static async recover(id: string, sampleRate: number): Promise<Blob | null> {
    validate(id, sampleRate)
    const root = await rootDirectory()
    if (!root) return null
    let directory: OpfsDirectory
    try { directory = await root.getDirectoryHandle(`${id}.pcm`) }
    catch (error) {
      if (!missing(error)) throw error
      // Existing single-file recordings remain readable; reads never acknowledge/delete them.
      try {
        const source = await (await root.getFileHandle(`${id}.wav`)).getFile()
        if (source.size <= 44) return null
        return new Blob([header(sampleRate, source.size - 44).buffer as ArrayBuffer, source.slice(44)], { type: 'audio/wav' })
      } catch (legacyError) { if (missing(legacyError)) return null; throw legacyError }
    }
    const metadata = JSON.parse(await (await (await directory.getFileHandle('metadata.json')).getFile()).text()) as { version?: number; sampleRate?: number }
    if (metadata.version !== 1 || metadata.sampleRate !== sampleRate) throw new Error('PCM recovery metadata does not match recording')
    return readChunks(directory, sampleRate)
  }

  /** Called only after replacement audio and session metadata have been acknowledged. */
  static async acknowledgeRecovery(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid PCM recovery ID')
    const root = await rootDirectory()
    if (!root) return
    for (const name of [`${id}.pcm`, `${id}.wav`]) {
      try { await root.removeEntry(name, { recursive: true }) }
      catch (error) { if (!missing(error)) throw error }
    }
  }

  append(audio: ArrayBuffer): Promise<void> {
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    if (!audio.byteLength || audio.byteLength % 2) return Promise.reject(new Error('Invalid PCM16 chunk'))
    const accepted = audio.slice(0)
    this.pending = this.pending.then(async () => {
      if (this.dataBytes + accepted.byteLength > 0xffffffff - 36) throw new Error('PCM recording exceeds WAV size limit')
      const name = `${String(this.index).padStart(10, '0')}.pcm`
      await writeCommitted(await this.directory.getFileHandle(name, { create: true }), accepted)
      this.index += 1; this.dataBytes += accepted.byteLength
    })
    return this.pending
  }

  finish(): Promise<Blob> {
    if (this.finished) return this.finished
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    this.closed = true
    this.finished = Promise.all([this.pending, this.metadataPending]).then(async () => (await readChunks(this.directory, this.sampleRate)) ?? new Blob([header(this.sampleRate, 0).buffer as ArrayBuffer], { type: 'audio/wav' }))
    return this.finished
  }

  async sealForRecovery(): Promise<void> {
    this.closed = true
    await Promise.allSettled([this.pending, this.metadataPending])
    this.releaseLease?.(); this.releaseLease = undefined
  }

  async discard(): Promise<void> {
    this.closed = true
    await Promise.all([this.pending, this.metadataPending]).catch(() => undefined)
    try { await this.root.removeEntry(this.name, { recursive: true }) }
    catch (error) { if (!missing(error)) throw error }
    finally { this.releaseLease?.(); this.releaseLease = undefined }
  }
}
