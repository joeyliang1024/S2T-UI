/** Bounded parallel I/O with ordered commits and a resumable contiguous prefix. */
export const orderedWindow = async <T>(input: {
  start: number; end: number; concurrency: number
  produce: (index: number) => Promise<T>
  commit: (value: T, index: number) => Promise<void>
  cancelled?: () => boolean
}): Promise<void> => {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) throw new Error('Invalid parallel window')
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown }
  const pending = new Map<number, Promise<Outcome>>()
  let next = input.start, failed = false
  const fill = (): void => {
    while (!failed && !input.cancelled?.() && next < input.end && pending.size < input.concurrency) {
      const index = next++
      pending.set(index, Promise.resolve().then(() => input.produce(index)).then(
        value => ({ ok: true as const, value }),
        error => { failed = true; return { ok: false as const, error } }
      ))
    }
  }
  fill()
  try {
    for (let index = input.start; index < input.end; index++) {
      if (input.cancelled?.()) throw new DOMException('Cancelled', 'AbortError')
      const task = pending.get(index)
      if (!task) throw new DOMException('Cancelled', 'AbortError')
      const outcome = await task
      if (!outcome.ok) throw outcome.error
      if (input.cancelled?.()) throw new DOMException('Cancelled', 'AbortError')
      await input.commit(outcome.value, index)
      pending.delete(index)
      fill()
    }
  } finally {
    // Do not let a failed/cancelled run's work leak into a subsequent import.
    await Promise.all(pending.values())
  }
}
