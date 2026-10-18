import type { WriteStream } from 'node:fs'
import { open } from 'node:fs/promises'

export type ActivePcmRecording = { path: string; stream: WriteStream; sampleRate: number; bytesWritten: number; writes: Promise<void> }
const closeStream = (stream: WriteStream): Promise<void> => stream.closed ? Promise.resolve() : new Promise(resolve => {
  stream.once('close', resolve)
  stream.destroy()
})
/** Trusted caller validates owner/IPC. Failure releases the descriptor but retains source + manifest. */
export const finalizeRecording = async (recording: ActivePcmRecording, { header, committed }: { header: (rate: number, bytes: number) => Uint8Array; committed: () => Promise<void> }): Promise<{ audioPath: string }> => {
  try {
    await recording.writes
    await new Promise<void>((resolve, reject) => {
      recording.stream.once('finish', resolve)
      recording.stream.once('error', reject)
      recording.stream.end()
    })
    await closeStream(recording.stream)
    const file = await open(recording.path, 'r+')
    try { await file.write(header(recording.sampleRate, recording.bytesWritten), 0) }
    finally { await file.close() }
    await committed()
    return { audioPath: recording.path }
  } finally { await closeStream(recording.stream) }
}

/** Remove admission synchronously, then release every owned recording even if one fails. */
export const releaseRecordings = async <T extends ActivePcmRecording>(records: Map<string, T>, owns: (recording: T) => boolean, finalize: (id: string, recording: T) => Promise<unknown>): Promise<void> => {
  const owned = [...records].filter(([, recording]) => owns(recording))
  for (const [id] of owned) records.delete(id)
  const results = await Promise.allSettled(owned.map(([id, recording]) => Promise.resolve().then(() => finalize(id, recording))))
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Recording release failed; recovery sources retained')
}
