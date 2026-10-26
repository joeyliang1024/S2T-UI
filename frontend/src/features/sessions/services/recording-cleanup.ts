import { requestEpoch } from '../../../shared/http/authenticated-client'
import { RemotePcmRecording, type RecordingCleanupTarget } from '../../capture/recording/adapters/remote-pcm-recording'
import { remoteSessionStorage } from './remote-session-storage'

/** OPFS recovery metadata is the durable cleanup intent. Remove it LAST. */
export const cleanupRecordingBackup = async ({ recordingId, target, draftId, removeLocal }: {
  recordingId: string
  target: RecordingCleanupTarget
  draftId?: string
  removeLocal: () => Promise<void>
}, dependencies = {
  removeRemote: RemotePcmRecording.cleanup,
  removeDraft: remoteSessionStorage.deleteLiveDraft,
  epoch: requestEpoch
}): Promise<void> => {
  const owner = dependencies.epoch()
  const check = (): void => { if (owner !== dependencies.epoch()) throw new DOMException('Account changed', 'AbortError') }
  check()
  await dependencies.removeRemote(recordingId, target); check()
  if (draftId) { await dependencies.removeDraft(draftId); check() }
  await removeLocal(); check()
}
