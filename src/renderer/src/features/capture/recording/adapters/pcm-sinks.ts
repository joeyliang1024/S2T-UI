import type { DesktopBridge } from '../../../../../../shared/contracts/desktop'
import { requestEpoch } from '../../../../shared/http/authenticated-client'
import type { LocalRecordingArtifact, OpfsRecordingArtifact, PcmSink, RemoteRecordingArtifact } from '../ports'
import { createPcmSink } from '../sink-lifecycle'
import type { OpfsPcmRecording } from './opfs-pcm-recording'
import type { RemotePcmRecording } from './remote-pcm-recording'

export const createDesktopPcmSink = (recordingId: string, bridge: Pick<DesktopBridge, 'appendPcm' | 'finishPcmRecording'>): PcmSink<LocalRecordingArtifact> => {
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  let finalizing: Promise<LocalRecordingArtifact> | undefined
  const finalize = (): Promise<LocalRecordingArtifact> => finalizing ??= (async () => { checkOwner(); const result = await bridge.finishPcmRecording(recordingId); return { kind: 'local', recordingId, audioPath: result.audioPath } })()
  return createPcmSink({
    append: audio => { checkOwner(); return bridge.appendPcm(recordingId, audio) },
    finish: finalize,
    // Main retains the manifest/source even when finalization fails. Abort is never delete.
    release: async () => { await finalize() }
  })
}
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
export const createBrowserPcmSink = ({ recordingId, recording, remoteRecording, onWriteStage }: { recordingId: string; recording: OpfsPcmRecording; remoteRecording: RemotePcmRecording | null; onWriteStage: (stage: 'idle' | 'browser' | 'remote') => void }): PcmSink<OpfsRecordingArtifact> => {
  const local = createOpfsPcmSink(recordingId, recording), remote = remoteRecording ? createRemotePcmSink(remoteRecording) : null
  return createPcmSink({
    append: async audio => {
      try { onWriteStage('browser'); await local.append(audio); if (remote) { onWriteStage('remote'); await remote.append(audio) } }
      finally { onWriteStage('idle') }
    },
    finish: async () => { const artifact = await local.finish(); await remote?.finish(); return artifact },
    release: async () => { await local.abort(); await remote?.abort() }
  })
}
