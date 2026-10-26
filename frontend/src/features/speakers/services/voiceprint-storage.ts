import { authFetch } from '../../auth/services/auth-client'

export type VoiceprintSharingScope = 'private' | 'department' | 'organization'
export type Voiceprint = { id: string; createdAt: string; NT: string; Department: string; dimensions: number; embeddingModel?: string; embeddingVersion?: string; sharingScope?: VoiceprintSharingScope }

const check = async (response: Response): Promise<void> => {
  if (response.ok) return
  const body = await response.json().catch(() => ({})) as { error?: string }
  throw new Error(body.error || `HTTP ${response.status}`)
}

export const voiceprintStorage = {
  async load(): Promise<Voiceprint[]> {
    const response = await authFetch('/api/voiceprints')
    await check(response)
    const body = await response.json() as { voiceprints?: Voiceprint[] }
    return Array.isArray(body.voiceprints) ? body.voiceprints : []
  },
  async enroll(audio: Blob, sharingScope: VoiceprintSharingScope, sharingConsent = false): Promise<Voiceprint> {
    const response = await authFetch('/api/voiceprints', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-s2t-voiceprint-sharing': sharingScope, ...(sharingScope !== 'private' && sharingConsent ? { 'x-s2t-voiceprint-consent': 'true' } : {}) }, body: audio })
    await check(response)
    return (await response.json() as { voiceprint: Voiceprint }).voiceprint
  },
  async remove(id: string): Promise<void> {
    const response = await authFetch(`/api/voiceprints/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await check(response)
  }
}
