import { activeTranslate } from '../i18n'

type OpfsDirectory = { getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsDirectory>; getFileHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsFile>; removeEntry?: (name: string) => Promise<void> }
type OpfsFile = { createWritable: () => Promise<OpfsWritable>; getFile: () => Promise<File> }
type OpfsWritable = { write: (data: unknown) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }

const header = (sampleRate: number, dataBytes: number): Uint8Array => {
  const bytes = new Uint8Array(44); const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, dataBytes, true)
  return bytes
}

/** Disk-backed browser PCM writer. Null from create means OPFS is unavailable. */
export class OpfsPcmRecording {
  private pending = Promise.resolve()
  private dataBytes = 0
  private closed = false
  private constructor(private readonly directory: OpfsDirectory, private readonly name: string, private readonly file: OpfsFile, private readonly writable: OpfsWritable, private readonly sampleRate: number) {}

  static async create(id: string, sampleRate: number): Promise<OpfsPcmRecording | null> {
    const storage = navigator.storage as unknown as { getDirectory?: () => Promise<OpfsDirectory> }
    if (!storage.getDirectory) return null
    const root = await storage.getDirectory()
    const directory = await root.getDirectoryHandle('s2t-ui-recordings', { create: true })
    const file = await directory.getFileHandle(`${id}.wav`, { create: true })
    const writable = await file.createWritable()
    await writable.write(header(sampleRate, 0))
    return new OpfsPcmRecording(directory, `${id}.wav`, file, writable, sampleRate)
  }

  static async recover(id: string, sampleRate: number): Promise<Blob | null> {
    const storage = navigator.storage as unknown as { getDirectory?: () => Promise<OpfsDirectory> }
    if (!storage.getDirectory) return null
    try {
      const root = await storage.getDirectory()
      const directory = await root.getDirectoryHandle('s2t-ui-recordings')
      const file = await directory.getFileHandle(`${id}.wav`)
      const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer())
      if (bytes.byteLength <= 44) return null
      const wav = new Blob([header(sampleRate, bytes.byteLength - 44).buffer as ArrayBuffer, bytes.slice(44).buffer as ArrayBuffer], { type: 'audio/wav' })
      await directory.removeEntry?.(`${id}.wav`).catch(() => undefined)
      return wav
    } catch { return null }
  }

  append(audio: ArrayBuffer): Promise<void> {
    if (this.closed) return Promise.reject(new Error(activeTranslate('svcOpfsRecordingClosed')))
    this.pending = this.pending.then(async () => { await this.writable.write(audio); this.dataBytes += audio.byteLength })
    return this.pending
  }

  async finish(): Promise<Blob> {
    if (this.closed) throw new Error(activeTranslate('svcOpfsRecordingClosed'))
    this.closed = true
    await this.pending
    await this.writable.write({ type: 'seek', position: 0 })
    await this.writable.write(header(this.sampleRate, this.dataBytes))
    await this.writable.close()
    return this.file.getFile()
  }

  async discard(): Promise<void> {
    if (!this.closed) { this.closed = true; await this.writable.abort?.().catch(() => undefined) }
    await this.directory.removeEntry?.(this.name).catch(() => undefined)
  }
}
