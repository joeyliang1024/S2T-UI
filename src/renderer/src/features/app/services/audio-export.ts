import { authFetch } from '../../auth/services/auth-client'

export type AudioDownloadFormat = 'wav' | 'm4a'

/** Menu order: the audio formats offered by every recording download entry point. */
export const audioDownloadFormats: readonly AudioDownloadFormat[] = ['wav', 'm4a']

/**
 * WAV → M4A. Electron runs the bundled ffmpeg build through the main process;
 * the web app uploads the WAV to the gateway transcoder, which runs the same
 * ffmpeg binary server-side.
 */
export const encodeM4a = async (wav: Blob): Promise<Blob> => {
  if (window.s2t) {
    const audio = await window.s2t.transcodeAudio({ audio: await wav.arrayBuffer(), target: 'm4a' })
    return new Blob([audio], { type: 'audio/mp4' })
  }
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
