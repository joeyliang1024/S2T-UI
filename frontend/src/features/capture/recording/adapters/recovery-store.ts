import { requestEpoch } from '../../../../shared/http/authenticated-client'
import type { RecordingRecoveryStore } from '../ports'
import { OpfsPcmRecording } from './opfs-pcm-recording'

export const createRecordingRecoveryStore = (ownerId: string): RecordingRecoveryStore => {
  const owner = requestEpoch()
  const check = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  const inspect: RecordingRecoveryStore['inspect'] = async () => {
    check(); const issues: string[] = []
    const entries = await OpfsPcmRecording.listRecoveries(ownerId, error => issues.push(error instanceof Error ? error.message : 'Recording recovery manifest could not be read'))
    check(); return { entries, issues }
  }
  return {
    inspect,
    read: async entry => {
      check()
      const current = (await inspect()).entries.find(item => item.recordingId === entry.recordingId)
      if (!current || current.ownerId !== ownerId) throw new Error('Recording recovery does not belong to this account')
      const audio = await OpfsPcmRecording.recover(current.recordingId, current.draft.sampleRate!)
      check(); return audio
    },
    acknowledge: async recordingId => {
      check()
      if ((await inspect()).entries.some(entry => entry.recordingId === recordingId)) { check(); await OpfsPcmRecording.acknowledgeRecovery(recordingId) }
    }
  }
}
