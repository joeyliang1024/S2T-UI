export type WavChunk = { audio: ArrayBuffer; startMs: number; endMs: number }
export type PcmWavFileLayout = { sampleRate: number; bytesPerFrame: number; dataOffset: number; dataSizeOffset: number; dataBytes: number; header: Uint8Array }

const fourCC = (view: DataView, offset: number): string => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))

const layoutOf = (input: ArrayBuffer, allowDataOutsideInput = false): PcmWavFileLayout => {
  if (input.byteLength < 44) throw new Error('WAV 檔案太小')
  const view = new DataView(input)
  if (fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') throw new Error('僅支援 RIFF/WAV 檔案')
  let offset = 12
  let sampleRate = 0
  let bytesPerFrame = 0
  let dataOffset = 0
  let dataSizeOffset = 0
  let dataBytes = 0
  while (offset + 8 <= input.byteLength) {
    const id = fourCC(view, offset)
    const size = view.getUint32(offset + 4, true)
    const content = offset + 8
    if (content + size > input.byteLength && !(allowDataOutsideInput && id === 'data')) throw new Error('WAV chunk 資料不完整')
    if (id === 'fmt ') {
      if (size < 16 || view.getUint16(content, true) !== 1 || view.getUint16(content + 14, true) !== 16) throw new Error('批次切分目前只支援 PCM16 WAV')
      sampleRate = view.getUint32(content + 4, true)
      bytesPerFrame = view.getUint16(content + 12, true)
    }
    if (id === 'data') { dataOffset = content; dataSizeOffset = offset + 4; dataBytes = size; break }
    offset = content + size + (size % 2)
  }
  if (!sampleRate || !bytesPerFrame || !dataOffset || !dataBytes) throw new Error('找不到有效的 PCM16 WAV 音訊資料')
  return { sampleRate, bytesPerFrame, dataOffset, dataSizeOffset, dataBytes, header: new Uint8Array(input.slice(0, dataOffset)) }
}

const wavSlice = (input: ArrayBuffer, layout: PcmWavFileLayout, startByte: number, endByte: number): ArrayBuffer => {
  const data = new Uint8Array(input, layout.dataOffset + startByte, endByte - startByte)
  const header = layout.header.slice()
  const view = new DataView(header.buffer)
  view.setUint32(4, header.byteLength - 8 + data.byteLength, true)
  view.setUint32(layout.dataSizeOffset, data.byteLength, true)
  const result = new Uint8Array(header.byteLength + data.byteLength)
  result.set(header); result.set(data, header.byteLength)
  return result.buffer
}

const segmentBytesFor = (layout: PcmWavFileLayout, segmentMs: number): number => {
  const bytesPerMs = layout.sampleRate * layout.bytesPerFrame / 1000
  return Math.max(layout.bytesPerFrame, Math.floor(segmentMs * bytesPerMs / layout.bytesPerFrame) * layout.bytesPerFrame)
}

const overlapBytesFor = (layout: PcmWavFileLayout, segmentBytes: number, overlapMs: number): number => {
  const bytesPerMs = layout.sampleRate * layout.bytesPerFrame / 1000
  return Math.min(segmentBytes - layout.bytesPerFrame, Math.floor(overlapMs * bytesPerMs / layout.bytesPerFrame) * layout.bytesPerFrame)
}

/** Read only the RIFF header needed to plan a large PCM16 WAV import. */
export const readPcmWavFileLayout = async (file: File): Promise<PcmWavFileLayout> => {
  const header = await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer()
  const layout = layoutOf(header, true)
  if (layout.dataOffset + layout.dataBytes > file.size) throw new Error('WAV chunk 資料不完整')
  return layout
}

export const pcmWavChunkCount = (layout: PcmWavFileLayout, segmentMs = 45_000, overlapMs = 1_500): number => {
  const segmentBytes = segmentBytesFor(layout, segmentMs)
  const advance = segmentBytes - overlapBytesFor(layout, segmentBytes, overlapMs)
  return Math.ceil(Math.max(0, layout.dataBytes - segmentBytes) / advance) + 1
}

/** Build one ASR WAV request without retaining the original file or other chunks. */
export const readPcmWavFileChunk = async (file: File, layout: PcmWavFileLayout, startByte: number, segmentMs = 45_000): Promise<WavChunk> => {
  const segmentBytes = segmentBytesFor(layout, segmentMs)
  const endByte = Math.min(layout.dataBytes, startByte + segmentBytes)
  const data = new Uint8Array(await file.slice(layout.dataOffset + startByte, layout.dataOffset + endByte).arrayBuffer())
  const header = layout.header.slice()
  const view = new DataView(header.buffer)
  view.setUint32(4, header.byteLength - 8 + data.byteLength, true)
  view.setUint32(layout.dataSizeOffset, data.byteLength, true)
  const result = new Uint8Array(header.byteLength + data.byteLength)
  result.set(header); result.set(data, header.byteLength)
  const bytesPerMs = layout.sampleRate * layout.bytesPerFrame / 1000
  return { audio: result.buffer, startMs: Math.round(startByte / bytesPerMs), endMs: Math.round(endByte / bytesPerMs) }
}

export const nextPcmWavChunkStart = (layout: PcmWavFileLayout, startByte: number, segmentMs = 45_000, overlapMs = 1_500): number => {
  const segmentBytes = segmentBytesFor(layout, segmentMs)
  const endByte = Math.min(layout.dataBytes, startByte + segmentBytes)
  return endByte === layout.dataBytes ? endByte : endByte - overlapBytesFor(layout, segmentBytes, overlapMs)
}

/** Split a PCM16 WAV into fixed-duration requests with a small audio overlap. */
export const splitPcmWav = (input: ArrayBuffer, segmentMs = 45_000, overlapMs = 1_500): WavChunk[] => {
  const layout = layoutOf(input)
  const bytesPerMs = layout.sampleRate * layout.bytesPerFrame / 1000
  const segmentBytes = segmentBytesFor(layout, segmentMs)
  const overlapBytes = overlapBytesFor(layout, segmentBytes, overlapMs)
  const chunks: WavChunk[] = []
  for (let start = 0; start < layout.dataBytes;) {
    const end = Math.min(layout.dataBytes, start + segmentBytes)
    chunks.push({ audio: wavSlice(input, layout, start, end), startMs: Math.round(start / bytesPerMs), endMs: Math.round(end / bytesPerMs) })
    if (end === layout.dataBytes) break
    start = end - overlapBytes
  }
  return chunks
}

/** Remove only a literal suffix/prefix duplicated by adjacent overlapped chunks. */
export const joinOverlappedText = (previous: string, next: string): string => {
  const left = previous.trim()
  const right = next.trim()
  const maximum = Math.min(left.length, right.length, 1_000)
  for (let count = maximum; count >= 3; count -= 1) {
    if (left.slice(-count) === right.slice(0, count)) return left + right.slice(count)
  }
  const needsSpace = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)
  return `${left}${needsSpace ? ' ' : ''}${right}`
}
