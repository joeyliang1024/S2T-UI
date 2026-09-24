import { authFetch } from '../../auth/services/auth-client'
import type { SavedSession } from '../../../shared/types'

const check = async (response: Response): Promise<void> => { if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) } }

export const remoteSessionStorage = {
  async load(): Promise<SavedSession[]> { const response = await authFetch('/api/data/sessions'); await check(response); const body = await response.json() as { sessions?: SavedSession[] }; return Array.isArray(body.sessions) ? body.sessions : [] },
  async save(sessions: SavedSession[]): Promise<void> { const response = await authFetch('/api/data/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions }) }); await check(response) },
  async saveAudio(id: string, audio: Blob): Promise<void> { const response = await authFetch(`/api/data/audio/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio }); await check(response) },
  async loadAudio(id: string): Promise<Blob | undefined> { const response = await authFetch(`/api/data/audio/${encodeURIComponent(id)}`); if (response.status === 404) return undefined; await check(response); return response.blob() },
  async deleteAudio(id: string): Promise<void> { const response = await authFetch(`/api/data/audio/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (response.status !== 404) await check(response) }
}
