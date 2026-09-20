const pcmToWav = (pcm: ArrayBuffer, sampleRate = 24_000): Blob => {
  const wav = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(wav)
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  new Uint8Array(wav, 44).set(new Uint8Array(pcm))
  return new Blob([wav], { type: 'audio/wav' })
}

export const synthesizeBreezeTts = async (input: {
  endpoint: string
  text: string
  instruction?: string
  cfgScale?: number
}): Promise<Blob> => {
  const body = new FormData()
  body.set('text', input.text)
  if (input.instruction?.trim()) body.set('instruction', input.instruction.trim())
  if (input.cfgScale) body.set('cfg_scale', String(input.cfgScale))
  const response = await fetch(input.endpoint, { method: 'POST', body })
  if (!response.ok) throw new Error(`Breeze TTS 回應 ${response.status}`)
  return pcmToWav(await response.arrayBuffer())
}
