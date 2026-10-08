import { retryableAuthFetch } from '../../auth/services/auth-client'
import { activeTranslate } from '../../../shared/i18n'
import type { ImportCheckpoint, LiveTranscriptDraft, SavedSession } from '../../../shared/types'

const check = async (response: Response): Promise<void> => { if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) } }

const remoteSession = (session: SavedSession): Omit<SavedSession, 'nativeAudioPath' | 'savedToDisk'> => {
  const { nativeAudioPath: _nativeAudioPath, savedToDisk: _savedToDisk, ...value } = session
  return value
}

export const remoteSessionStorage = {
  async load(): Promise<{ sessions: SavedSession[]; version: number }> {
    const response = await retryableAuthFetch('/api/data/sessions'); await check(response)
    const body = await response.json() as { sessions?: SavedSession[]; version?: number }
    return { sessions: Array.isArray(body.sessions) ? body.sessions : [], version: Number.isSafeInteger(body.version) && body.version! >= 0 ? body.version! : 0 }
  },
  async save(sessions: SavedSession[], version: number): Promise<number> {
    const requestBody = JSON.stringify({ sessions: sessions.map(remoteSession), version })
    let compressed: ArrayBuffer | undefined
    if (requestBody.length >= 256 * 1024 && typeof CompressionStream !== 'undefined') {
      const payload = new Blob([requestBody])
      compressed = await new Response(payload.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
      if (compressed.byteLength >= payload.size || compressed.byteLength > 8 * 1024 * 1024) compressed = undefined
    }
    let response = await retryableAuthFetch('/api/data/sessions', { method: 'POST', headers: { 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) }, body: compressed ?? requestBody })
    // During rollout an older gateway can reject gzip before any CAS write.
    // Retry the identical version as plain JSON; never retry a 409 conflict here.
    if (compressed && [400, 415].includes(response.status)) {
      await response.arrayBuffer()
      response = await retryableAuthFetch('/api/data/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody })
    }
    await check(response)
    const body = await response.json() as { version?: number }
    if (!Number.isSafeInteger(body.version) || body.version! < 1) throw new Error(activeTranslate('svcRemoteInvalidVersion'))
    return body.version!
  },
  async saveAudio(id: string, audio: Blob): Promise<void> { const response = await retryableAuthFetch(`/api/data/audio/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio }); await check(response) },
  async loadAudio(id: string): Promise<Blob | undefined> { const response = await retryableAuthFetch(`/api/data/audio/${encodeURIComponent(id)}`); if (response.status === 404) return undefined; await check(response); return response.blob() },
  async deleteAudio(id: string): Promise<void> { const response = await retryableAuthFetch(`/api/data/audio/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (response.status !== 404) await check(response) },
  async loadLiveDraft(): Promise<LiveTranscriptDraft | undefined> { const response = await retryableAuthFetch('/api/data/live-draft'); await check(response); const body = await response.json() as { value?: LiveTranscriptDraft }; return body.value?.id && Array.isArray(body.value.segments) ? body.value : undefined },
  async saveLiveDraft(value: LiveTranscriptDraft): Promise<void> { await check(await retryableAuthFetch('/api/data/live-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })) },
  async deleteLiveDraft(): Promise<void> { await check(await retryableAuthFetch('/api/data/live-draft', { method: 'DELETE' })) },
  async loadImportCheckpoint(): Promise<ImportCheckpoint | undefined> { const response = await retryableAuthFetch('/api/data/import-checkpoint'); await check(response); const body = await response.json() as { value?: ImportCheckpoint }; return body.value?.fingerprint && Array.isArray(body.value.segments) ? body.value : undefined },
  async saveImportCheckpoint(value: ImportCheckpoint): Promise<void> { await check(await retryableAuthFetch('/api/data/import-checkpoint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })) },
  async deleteImportCheckpoint(): Promise<void> { await check(await retryableAuthFetch('/api/data/import-checkpoint', { method: 'DELETE' })) }
}
