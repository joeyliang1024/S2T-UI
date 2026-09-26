import { authFetch } from '../../auth/services/auth-client'
import type { SavedSession } from '../../../shared/types'

const check = async (response: Response): Promise<void> => { if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) } }

const remoteSession = (session: SavedSession): Omit<SavedSession, 'nativeAudioPath' | 'savedToDisk'> => {
  const { nativeAudioPath: _nativeAudioPath, savedToDisk: _savedToDisk, ...value } = session
  return value
}

export const remoteSessionStorage = {
  async load(): Promise<{ sessions: SavedSession[]; version: number }> {
    const response = await authFetch('/api/data/sessions'); await check(response)
    const body = await response.json() as { sessions?: SavedSession[]; version?: number }
    return { sessions: Array.isArray(body.sessions) ? body.sessions : [], version: Number.isSafeInteger(body.version) && body.version! >= 0 ? body.version! : 0 }
  },
  async save(sessions: SavedSession[], version: number): Promise<number> {
    const response = await authFetch('/api/data/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions: sessions.map(remoteSession), version }) })
    await check(response)
    const body = await response.json() as { version?: number }
    if (!Number.isSafeInteger(body.version) || body.version! < 1) throw new Error('遠端沒有回傳有效的紀錄版本')
    return body.version!
  },
  async saveAudio(id: string, audio: Blob): Promise<void> { const response = await authFetch(`/api/data/audio/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio }); await check(response) },
  async loadAudio(id: string): Promise<Blob | undefined> { const response = await authFetch(`/api/data/audio/${encodeURIComponent(id)}`); if (response.status === 404) return undefined; await check(response); return response.blob() },
  async deleteAudio(id: string): Promise<void> { const response = await authFetch(`/api/data/audio/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (response.status !== 404) await check(response) }
}
