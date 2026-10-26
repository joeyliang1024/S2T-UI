import { OpfsWriteClient } from './opfs-write-client'
import { storageDeadline } from '../../../../shared/services/storage-deadline'
import type { LiveTranscriptDraft } from '../../../../../shared/contracts/sessions'
import { validateRecoveryEntry, type RecordingRecoveryEntry } from '../recovery-manifest'
import { activeTranslate } from '../../../../shared/i18n'

type OpfsDirectory = { getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsDirectory>; getFileHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsFile>; removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>; entries: () => AsyncIterableIterator<[string, unknown]> }
type OpfsFile = { native?: OpfsFile; createWritable: () => Promise<OpfsWritable>; getFile: () => Promise<File> }
type OpfsWritable = { write: (data: unknown) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }
const missing = (error: unknown): boolean => error instanceof DOMException && error.name === 'NotFoundError'
const validate = (id: string, sampleRate: number): void => {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 0x7fffffff) throw new Error('Invalid PCM recovery context')
}
const boundedDirectory = (directory: OpfsDirectory): OpfsDirectory => ({
  getDirectoryHandle: async (name, options) => boundedDirectory(await storageDeadline(directory.getDirectoryHandle(name, options))),
  getFileHandle: async (name, options) => {
    const file = await storageDeadline(directory.getFileHandle(name, options))
    return { native: file, createWritable: () => file.createWritable(), getFile: () => storageDeadline(file.getFile()) }
  },
  removeEntry: (name, options) => storageDeadline(directory.removeEntry(name, options)),
  entries: async function* () {
    const iterator = directory.entries()[Symbol.asyncIterator]()
    try { for (;;) { const item = await storageDeadline(iterator.next()); if (item.done) break; yield item.value } }
    finally { if (iterator.return) void iterator.return().catch(() => undefined) }
  }
})
const rootDirectory = async (): Promise<OpfsDirectory | null> => {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<OpfsDirectory> }
  return storage.getDirectory ? boundedDirectory(await storageDeadline((await storageDeadline(storage.getDirectory())).getDirectoryHandle('s2t-ui-recordings', { create: true }))) : null
}

const leaseName = (id: string): string => `s2t-pcm-capture:${id}`
const acquireLease = async (id: string): Promise<(() => void) | undefined> => {
  if (!navigator.locks) return undefined
  return storageDeadline(new Promise<() => void>((resolve, reject) => {
    void navigator.locks.request(leaseName(id), { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('Recording is active in another context')); return }
      await new Promise<void>(release => resolve(release))
    }).catch(reject)
  }), release => release())
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
  let writer: OpfsWritable | undefined, expired = false
  const abort = (): void => { try { if (writer?.abort) void Promise.resolve(writer.abort()).catch(() => undefined) } catch { /* Aborting must never mask the original storage failure. */ } }
  const task = (async () => {
    writer = await file.createWritable()
    if (expired) { abort(); return }
    try {
      await writer.write(bytes)
      if (expired) { abort(); return }
      await writer.close()
    } catch (error) { abort(); throw error }
  })()
  try { await storageDeadline(task) }
  catch (error) { expired = true; abort(); throw error }
}
const readChunks = async (directory: OpfsDirectory, sampleRate: number, version = 1): Promise<Blob | null> => {
  const names: string[] = []
  for await (const [name] of directory.entries()) if (/^\d{10}\.pcm$/.test(name)) names.push(name)
  names.sort()
  const files: File[] = []; let bytes = 0
  for (const [index, name] of names.entries()) {
    // A missing chunk cannot be papered over by joining later audio onto the prefix.
    if (name !== `${String(index).padStart(10, '0')}.pcm`) throw new Error('PCM recovery chunk sequence is damaged')
    const file = await (await directory.getFileHandle(name)).getFile()
    if (version === 2) {
      let committed: { bytes?: number }
      try { committed = JSON.parse(await storageDeadline((await (await directory.getFileHandle(name + '.commit')).getFile()).text())) as { bytes?: number } }
      catch (error) {
        if (index === names.length - 1 && (missing(error) || error instanceof SyntaxError)) break
        throw error
      }
      if (committed.bytes !== file.size) throw new Error('PCM recovery commit does not match audio')
    }
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
  private readonly chunkEnds: number[] = []
  private writeClient: OpfsWriteClient | null = null
  get persistedSamples(): number { return this.dataBytes / 2 }
  private storageFailure?: unknown
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
    await writeCommitted(await directory.getFileHandle('metadata.json', { create: true }), JSON.stringify({ version: 2, sampleRate }))
    const recovery = context ? validateRecoveryEntry({ version: 1, ownerId: context.ownerId, recordingId: id, captureOffsetMs: context.captureOffsetMs, draft: structuredClone(context.draft) }, id) : undefined
    if (recovery && recovery.draft.sampleRate !== sampleRate) throw new Error('Recording recovery sample rate mismatch')
    if (recovery) await writeCommitted(await directory.getFileHandle('recovery.json', { create: true }), JSON.stringify(recovery))
    const recording = new OpfsPcmRecording(root, name, directory, sampleRate, recovery, releaseLease)
    recording.writeClient = await OpfsWriteClient.create()
    return recording
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
        const value = JSON.parse(await storageDeadline((await (await directory.getFileHandle('recovery.json')).getFile()).text())) as { ownerId?: unknown }
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
    if (this.storageFailure) return Promise.reject(this.storageFailure)
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    // Metadata uses its own sequence so a failed checkpoint does not poison accepted audio writes.
    const operation = this.metadataPending.then(async () => {
      if (this.storageFailure) throw this.storageFailure
      if (!this.recovery) throw new Error('Recording has no owned recovery context')
      const next = validateRecoveryEntry(update(this.recovery), this.name.slice(0, -4))
      await writeCommitted(await this.directory.getFileHandle('recovery.json', { create: true }), JSON.stringify(next))
      this.recovery = next
    })
    this.metadataPending = operation.catch(error => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        this.storageFailure = error
        this.writeClient?.close()
      }
    })
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
    const metadata = JSON.parse(await storageDeadline((await (await directory.getFileHandle('metadata.json')).getFile()).text())) as { version?: number; sampleRate?: number }
    if (![1, 2].includes(metadata.version ?? 0) || metadata.sampleRate !== sampleRate) throw new Error('PCM recovery metadata does not match recording')
    return readChunks(directory, sampleRate, metadata.version)
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
    if (this.storageFailure) return Promise.reject(this.storageFailure)
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    if (!audio.byteLength || audio.byteLength % 2) return Promise.reject(new Error('Invalid PCM16 chunk'))
    const accepted = audio.slice(0)
    this.pending = this.pending.then(async () => {
      if (this.storageFailure) throw this.storageFailure
      if (this.dataBytes + accepted.byteLength > 0xffffffff - 36) throw new Error('PCM recording exceeds WAV size limit')
      const name = `${String(this.index).padStart(10, '0')}.pcm`
      const file = await this.directory.getFileHandle(name, { create: true })
      const commit = await this.directory.getFileHandle(name + '.commit', { create: true })
      if (!this.writeClient || !await this.writeClient.write(file.native ?? file, accepted, commit.native ?? commit)) {
        await writeCommitted(file, accepted)
        await writeCommitted(commit, JSON.stringify({ bytes: accepted.byteLength }))
      }
      this.index += 1; this.dataBytes += accepted.byteLength
      this.chunkEnds.push(this.dataBytes)
    }).catch(error => { this.storageFailure = error; throw error })
    return this.pending
  }

  /** Read only durable ranges; never materialize the full recording for upload. */
  async readCommittedAudio(startSample: number, maximumSamples: number): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(startSample) || startSample < 0 || !Number.isSafeInteger(maximumSamples) || maximumSamples <= 0) throw new Error('Invalid committed PCM range')
    const start = startSample * 2, end = Math.min(this.dataBytes, start + Math.min(maximumSamples, 512 * 1024) * 2)
    if (start >= end) return new ArrayBuffer(0)
    let low = 0, high = this.chunkEnds.length
    while (low < high) { const middle = (low + high) >>> 1; if (this.chunkEnds[middle] <= start) low = middle + 1; else high = middle }
    const pieces: Blob[] = []
    for (let index = low; index < this.chunkEnds.length; index++) {
      const offset = index ? this.chunkEnds[index - 1] : 0
      if (offset >= end) break
      const file = await (await this.directory.getFileHandle(`${String(index).padStart(10, '0')}.pcm`)).getFile()
      pieces.push(file.slice(Math.max(0, start - offset), Math.min(file.size, end - offset)))
    }
    const bytes = await storageDeadline(new Blob(pieces).arrayBuffer())
    if (bytes.byteLength !== end - start) throw new Error('Committed PCM range is incomplete')
    return bytes
  }

  finish(): Promise<Blob> {
    if (this.finished) return this.finished
    if (this.storageFailure) return Promise.reject(this.storageFailure)
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    this.closed = true
    this.finished = Promise.all([this.pending, this.metadataPending]).then(async () => {
      if (this.storageFailure) throw this.storageFailure
      return (await readChunks(this.directory, this.sampleRate, 2)) ?? new Blob([header(this.sampleRate, 0).buffer as ArrayBuffer], { type: 'audio/wav' })
    })
    return this.finished
  }

  async sealForRecovery(): Promise<void> {
    this.closed = true
    await Promise.allSettled([this.pending, this.metadataPending])
    this.writeClient?.close(); this.writeClient = null
    this.releaseLease?.(); this.releaseLease = undefined
  }

  async discard(): Promise<void> {
    this.closed = true
    await Promise.all([this.pending, this.metadataPending]).catch(() => undefined)
    try { await this.root.removeEntry(this.name, { recursive: true }) }
    catch (error) { if (!missing(error)) throw error }
    finally { this.writeClient?.close(); this.writeClient = null; this.releaseLease?.(); this.releaseLease = undefined }
  }
}
