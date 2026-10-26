/** Deadline for browser storage. Late results are observed, never blindly retried. */
export const storageDeadline = <T>(operation: Promise<T>, onLate?: (value: T) => void, timeoutMs = 30_000): Promise<T> => {
  let expired = false, timer: ReturnType<typeof setTimeout>
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new DOMException('Browser storage timed out; committed audio retained', 'TimeoutError')) }, timeoutMs)
    void operation.then(value => {
      clearTimeout(timer)
      if (expired) { try { onLate?.(value) } catch { /* Best-effort late resource disposal. */ } }
      else resolve(value)
    }, error => { clearTimeout(timer); if (!expired) reject(error) })
  })
}
