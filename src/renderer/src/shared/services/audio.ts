


export const dbfs = (value: number): number => (value > 0 ? Math.max(-60, 20 * Math.log10(value)) : -60)

export const dbfsLabel = (value: number): string => `${value.toFixed(0)} dBFS`

export const meterPercent = (value: number): number => Math.max(0, Math.min(100, ((value + 60) / 60) * 100))

export const makeWav = (chunks: Float32Array[], sampleRate: number): Blob => {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + sampleCount * bytesPerSample)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * bytesPerSample, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * bytesPerSample, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const normalized = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
      offset += bytesPerSample
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export const pcm16 = (samples: Float32Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  samples.forEach((sample, index) => {
    const normalized = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
  })
  return buffer
}
