import type { SavedSession } from '../../../../../shared/contracts/sessions'

export type SessionOutboxSnapshot = { baseline: SavedSession[]; local: SavedSession[] }
export interface SessionOutbox {
  read(): Promise<SessionOutboxSnapshot | undefined>
  save(snapshot: SessionOutboxSnapshot): Promise<void>
  acknowledge(local: SavedSession[]): Promise<boolean>
  close(): Promise<void>
}

type PendingRecord = SessionOutboxSnapshot & { version: 1; userId: string; key: string; updatedAt: string }
const tabKey = 's2t-session-outbox-owner'

/** Transient recovery queue, never an independent history source. Each tab and account owns its record. */
export const createSessionOutbox = (userId: string): SessionOutbox => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('Invalid session outbox account')
  let owner = sessionStorage.getItem(tabKey)
  if (!owner || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) { owner = crypto.randomUUID(); sessionStorage.setItem(tabKey, owner) }
  const key = `${userId}:${owner}`
  let closed = false, closing = false, serial: Promise<unknown> = Promise.resolve()
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open('s2t-session-outbox', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('pending', { keyPath: 'key' }) }
    request.onsuccess = () => { const db = request.result; if (blocked) { db.close(); return }; db.onversionchange = () => db.close(); resolve(db) }
    request.onerror = () => reject(request.error || new Error('Cannot open session recovery queue'))
    request.onblocked = () => { blocked = true; reject(new Error('Session recovery queue upgrade is blocked')) }
  })
  // Observe rejected open promises even when initialization is canceled before its first read.
  void opened.catch(() => undefined)
  const check = (): void => { if (closed) throw new DOMException('Session outbox closed', 'AbortError') }
  const validate = (value: unknown): PendingRecord | undefined => {
    if (value === undefined) return undefined
    const record = value as Partial<PendingRecord>
    if (!record || record.version !== 1 || record.userId !== userId || record.key !== key || !Array.isArray(record.baseline) || !Array.isArray(record.local)) throw new Error('Session recovery queue is damaged; existing data was retained')
    for (const entry of [...record.baseline, ...record.local]) if (!entry || typeof entry.id !== 'string') throw new Error('Session recovery queue contains an invalid record')
    return record as PendingRecord
  }
  const transact = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> => {
    check(); const db = await opened; check()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('pending', mode)
      let result: T
      transaction.oncomplete = () => closed ? reject(new DOMException('Session outbox closed', 'AbortError')) : resolve(result)
      transaction.onerror = () => reject(transaction.error || new Error('Session recovery queue transaction failed'))
      transaction.onabort = () => reject(transaction.error || new Error('Session recovery queue transaction aborted'))
      try { action(transaction.objectStore('pending'), value => { result = value }, error => { transaction.abort(); reject(error) }) }
      catch (error) { transaction.abort(); reject(error) }
    })
  }
  const ordered = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (closing || closed) return Promise.reject(new DOMException('Session outbox closed', 'AbortError'))
    const next = serial.catch(() => undefined).then(operation)
    serial = next; return next
  }
  return {
    read: () => ordered(() => transact<SessionOutboxSnapshot | undefined>('readonly', (store, result, fail) => {
      const request = store.get(key)
      request.onsuccess = () => { try { const record = validate(request.result); result(record && { baseline: record.baseline, local: record.local }) } catch (error) { fail(error) } }
    })),
    save: snapshot => {
      // Clone at acceptance, so callers cannot mutate a queued checkpoint while another transaction runs.
      const record: PendingRecord = { ...structuredClone(snapshot), version: 1, userId, key, updatedAt: new Date().toISOString() }
      return ordered(() => transact<void>('readwrite', (store, result) => { store.put(record); result(undefined) }))
    },
    acknowledge: local => {
      const expected = JSON.stringify(local)
      return ordered(() => transact<boolean>('readwrite', (store, result, fail) => {
        const request = store.get(key)
        request.onsuccess = () => {
          try {
          const record = validate(request.result)
          const matches = Boolean(record && JSON.stringify(record.local) === expected)
          if (matches) store.delete(key)
          result(matches)
          } catch (error) { fail(error) }
        }
      }))
    },
    close: async () => { closing = true; await serial.catch(() => undefined); closed = true; await opened.then(db => db.close()).catch(() => undefined) }
  }
}
