import { DurableRecordingUpload } from '../durable-upload'
import { requestEpoch } from '../../../../shared/http/authenticated-client'
import type { OpfsRecordingArtifact, PcmSink, RemoteRecordingArtifact } from '../ports'
import { createPcmSink } from '../sink-lifecycle'
import type { OpfsPcmRecording } from './opfs-pcm-recording'
import type { RemotePcmRecording } from './remote-pcm-recording'

export const createOpfsPcmSink = (recordingId: string, recording: OpfsPcmRecording): PcmSink<OpfsRecordingArtifact> => createPcmSink({
  append: audio => recording.append(audio),
  finish: async () => ({ kind: 'opfs', recordingId, audio: await recording.finish() }),
  release: () => recording.sealForRecovery() // Retain committed chunks, release cross-tab capture ownership.
})
export const createRemotePcmSink = (recording: RemotePcmRecording): PcmSink<RemoteRecordingArtifact> => {
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  return createPcmSink({
    append: audio => { checkOwner(); return recording.append(audio) },
    finish: async () => { checkOwner(); await recording.finish(); return { kind: 'remote', recordingId: recording.id, persistedSamples: recording.persistedSamples } },
    release: async () => {} // Leave acknowledged chunks for a later recovery/finish.
  })
}
export const createBrowserPcmSink = ({ recordingId, recording, remoteRecording, onWriteStage, onRemoteWaiting }: { recordingId: string; recording: OpfsPcmRecording; remoteRecording: RemotePcmRecording | null; onWriteStage: (stage: 'idle' | 'browser' | 'remote') => void; onRemoteWaiting?: (waiting: boolean, error?: unknown) => void }): PcmSink<OpfsRecordingArtifact> => {
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  const local = createOpfsPcmSink(recordingId, recording)
  const upload = remoteRecording ? new DurableRecordingUpload(recording, remoteRecording, onRemoteWaiting, 30000, { minimumBytes: 1024 * 1024, maximumDelayMs: 30000 }) : null
  return createPcmSink({
    append: async audio => {
      try { checkOwner(); onWriteStage('browser'); await local.append(audio); checkOwner(); upload?.notify() }
      finally { onWriteStage('idle') }
    },
    finish: async () => {
      checkOwner()
      const artifact = await local.finish()
      try { await upload?.finish() } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        onRemoteWaiting?.(true, error)
      }
      checkOwner() // Local audio remains available for save/download/recovery.
      return artifact
    },
    release: async () => { await upload?.abort(); await local.abort() }
  })
}
