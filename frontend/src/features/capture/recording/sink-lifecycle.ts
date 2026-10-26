import type { PcmSink, RecordingArtifact } from './ports'

/** Serialize accepted bytes and terminal operations without sharing platform inheritance. */
export const createPcmSink = <T extends RecordingArtifact>(operations: { append: (audio: ArrayBuffer) => Promise<unknown>; finish: () => Promise<T>; release: () => Promise<void> }): PcmSink<T> => {
  let pending = Promise.resolve(), closed = false
  let finished: Promise<T> | undefined, aborted: Promise<void> | undefined
  const rejectClosed = (): Error => new Error('PCM sink is closed')
  return {
    append: audio => {
      if (closed) return Promise.reject(rejectClosed())
      if (!audio.byteLength || audio.byteLength % 2) return Promise.reject(new Error('Invalid PCM16 chunk'))
      const accepted = audio.slice(0)
      const write = pending.then(() => operations.append(accepted)).then(() => undefined)
      pending = write
      // Closing after a failed append must not create an unhandled rejected internal queue.
      void pending.catch(() => undefined)
      return write
    },
    finish: () => {
      if (finished) return finished
      if (closed) return Promise.reject(rejectClosed())
      closed = true
      finished = pending.then(operations.finish)
      return finished
    },
    abort: () => {
      if (aborted) return aborted
      closed = true
      aborted = (finished ?? pending).catch(() => undefined).then(operations.release)
      return aborted
    }
  }
}
