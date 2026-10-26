import { authFetch } from '../../auth/services/auth-client'

export type AudioDownloadFormat = 'wav' | 'm4a'

/** Menu order: the audio formats offered by every recording download entry point. */
export const audioDownloadFormats: readonly AudioDownloadFormat[] = ['wav', 'm4a']

/** Encode WAV to M4A through the Python audio API. */
export const encodeM4a = async (wav: Blob): Promise<Blob> => {

  const response = await authFetch('/api/audio-processing/transcode?format=m4a', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `HTTP ${response.status}`)
  }
  return new Blob([await response.arrayBuffer()], { type: 'audio/mp4' })
}
