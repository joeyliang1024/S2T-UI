// Only committed per-chunk handles cross this boundary. No microphone, account
// credentials or growing audio queue lives in the storage worker.
export {}
type SyncFile = { write: (bytes: Uint8Array, options: { at: number }) => number; truncate: (size: number) => void; flush: () => void; close: () => void }
type WorkerFile = { createSyncAccessHandle?: () => Promise<SyncFile> }
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; file?: WorkerFile; audio?: ArrayBuffer; commit?: WorkerFile }>) => void) | null
  postMessage: (value: unknown) => void
}
scope.onmessage = event => {
  const { id, file, audio, commit } = event.data
  if (!file || !audio) { scope.postMessage({ id, ready: true }); return }
  void (async () => {
    // Unsupported browsers fall back before any write has begun.
    if (!file.createSyncAccessHandle || !commit?.createSyncAccessHandle) { scope.postMessage({ id, unsupported: true }); return }
    let handle: SyncFile | undefined
    try {
      handle = await file.createSyncAccessHandle()
      const bytes = new Uint8Array(audio)
      let offset = 0
      while (offset < bytes.length) {
        const written = handle.write(bytes.subarray(offset), { at: offset })
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error('Incomplete OPFS write')
        offset += written
      }
      handle.truncate(bytes.length)
      handle.flush()
      handle.close(); handle = undefined
      // A crash can expose partially written sync files. Publish a separate
      // durable commit only after the complete PCM file has been flushed.
      handle = await commit.createSyncAccessHandle()
      const marker = new TextEncoder().encode(JSON.stringify({ bytes: bytes.length }))
      let markerOffset = 0
      while (markerOffset < marker.length) {
        const written = handle.write(marker.subarray(markerOffset), { at: markerOffset })
        if (!Number.isInteger(written) || written <= 0 || written > marker.length - markerOffset) throw new Error('Incomplete OPFS commit')
        markerOffset += written
      }
      handle.truncate(marker.length); handle.flush(); handle.close(); handle = undefined
      scope.postMessage({ id, committed: true })
    } catch (error) {
      try { handle?.close() } catch { /* Keep the original storage error. */ }
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'OPFS write failed' })
    }
  })()
}
