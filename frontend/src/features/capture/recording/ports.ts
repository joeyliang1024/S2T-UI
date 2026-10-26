import type { RecordingRecoveryEntry } from './recovery-manifest'
export type OpfsRecordingArtifact = { kind: 'opfs'; recordingId: string; audio: Blob }
export type RemoteRecordingArtifact = { kind: 'remote'; recordingId: string; persistedSamples: number }
export type RecordingArtifact = OpfsRecordingArtifact | RemoteRecordingArtifact
export interface PcmSink<T extends RecordingArtifact = RecordingArtifact> {
  append(audio: ArrayBuffer): Promise<void>
  /** Idempotent; rejects subsequent appends and waits for accepted writes. */
  finish(): Promise<T>
  /** Stops accepting writes and releases active I/O without deleting recovery evidence. */
  abort(): Promise<void>
}

export interface RecordingRecoveryStore {
  inspect(): Promise<{ entries: RecordingRecoveryEntry[]; issues: string[] }>
  read(entry: RecordingRecoveryEntry): Promise<Blob | null>
  acknowledge(recordingId: string): Promise<void>
}
