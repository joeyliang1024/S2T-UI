/** Subscription state is shared by composition; adapter lifecycles remain independent. */
export class EventChannel<T> {
  private readonly listeners = new Set<(value: T) => void>()
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(value: T): void { for (const listener of this.listeners) listener(value) }
  clear(): void { this.listeners.clear() }
}
