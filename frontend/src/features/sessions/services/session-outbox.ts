import type { SavedSession } from '../../../../shared/contracts/sessions'
import { storageDeadline } from '../../../shared/services/storage-deadline'

export type SessionOutboxSnapshot = { baseline: SavedSession[]; local: SavedSession[] }
export interface SessionOutbox {
  read(): Promise<SessionOutboxSnapshot | undefined>
  save(snapshot: SessionOutboxSnapshot): Promise<void>
  acknowledge(local: SavedSession[]): Promise<boolean>
  close(): Promise<void>
}
type Source = { key: string; stamp: string }
type PendingRecord = SessionOutboxSnapshot & { version: 1; userId: string; key: string; updatedAt: string; sources?: Source[] }
// Per-document identity avoids duplicated tabs inheriting the same sessionStorage owner.
const documentOwner = crypto.randomUUID()
const lease = async (key: string): Promise<(() => void) | undefined> => {
  if (!navigator.locks) return undefined
  return storageDeadline(new Promise<(() => void) | undefined>((resolve, reject) => {
    void navigator.locks.request(`s2t-outbox:${key}`, { ifAvailable: true }, async lock => {
      if (!lock) { resolve(undefined); return }
      await new Promise<void>(release => resolve(release))
    }).catch(reject)
  }), release => release?.())
}
const stamp = async (value: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), n => n.toString(16).padStart(2, '0')).join('')

/** Own journal plus inactive-owner handoff; originals survive until a matching remote ACK. */
export const createSessionOutbox = (userId: string): SessionOutbox => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('Invalid session outbox account')
  sessionStorage.setItem('s2t-session-outbox-owner', documentOwner)
  const key = `${userId}:${documentOwner}`
  let closed = false, closing = false, serial: Promise<unknown> = Promise.resolve()
  const sources = new Map<string, Source>(), releases = new Map<string, () => void>()
  let adopted: SessionOutboxSnapshot | undefined
  const ownership = lease(key).then(release => {
    if (navigator.locks && !release) throw new Error('Session recovery owner is still active')
    return release
  })
  void ownership.catch(() => undefined)
  const opened = storageDeadline(new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open('s2t-session-outbox', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('pending', { keyPath: 'key' }) }
    request.onsuccess = () => { const db = request.result; if (blocked) { db.close(); return }; db.onversionchange = () => db.close(); resolve(db) }
    request.onerror = () => reject(request.error || new Error('Cannot open session recovery queue'))
    request.onblocked = () => { blocked = true; reject(new Error('Session recovery queue upgrade is blocked')) }
  }), db => db.close())
  void opened.catch(() => undefined)
  const check = (): void => { if (closed) throw new DOMException('Session outbox closed', 'AbortError') }
  const validate = (value: unknown, expected = key): PendingRecord | undefined => {
    if (value === undefined) return undefined
    const record = value as Partial<PendingRecord>
    if (!record || record.version !== 1 || record.userId !== userId || record.key !== expected || !Array.isArray(record.baseline) || !Array.isArray(record.local)) throw new Error('Session recovery queue is damaged; existing data was retained')
    for (const entry of [...record.baseline, ...record.local]) if (!entry || typeof entry.id !== 'string') throw new Error('Session recovery queue contains an invalid record')
    if (record.sources && (!Array.isArray(record.sources) || record.sources.some(s => !s || !s.key.startsWith(userId + ':') || s.key === key || !/^[a-f0-9]{64}$/.test(s.stamp)))) throw new Error('Session recovery ownership metadata is damaged')
    return record as PendingRecord
  }
  const transact = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> => {
    check(); await ownership; const db = await opened; check()
    let transaction: IDBTransaction | undefined
    const operation = new Promise<T>((resolve, reject) => {
      transaction = db.transaction('pending', mode)
      let result: T
      transaction.oncomplete = () => closed ? reject(new DOMException('Session outbox closed', 'AbortError')) : resolve(result)
      transaction.onerror = () => reject(transaction!.error || new Error('Session recovery queue transaction failed'))
      transaction.onabort = () => reject(transaction!.error || new Error('Session recovery queue transaction aborted'))
      try { action(transaction.objectStore('pending'), value => { result = value }, error => { transaction!.abort(); reject(error) }) }
      catch (error) { transaction.abort(); reject(error) }
    })
    try { return await storageDeadline(operation) }
    catch (error) { try { transaction?.abort() } catch { /* Already settled. */ }; throw error }
  }
  const get = (recordKey: string): Promise<PendingRecord | undefined> => transact('readonly', (store, result, fail) => {
    const request = store.get(recordKey)
    request.onsuccess = () => { try { result(validate(request.result, recordKey)) } catch (error) { fail(error) } }
  })
  const ordered = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (closing || closed) return Promise.reject(new DOMException('Session outbox closed', 'AbortError'))
    const next = serial.catch(() => undefined).then(operation)
    serial = next; return next
  }
  const releaseSources = (): void => { for (const release of releases.values()) release(); releases.clear(); sources.clear(); adopted = undefined }
  return {
    read: () => ordered(async () => {
      const own = await get(key)
      if (own) {
        for (const source of own.sources ?? []) {
          sources.set(source.key, source)
          if (!releases.has(source.key) && await get(source.key)) {
            const release = await lease(source.key)
            if (!release) throw new Error('Recovered edits are active in another tab; existing data was retained')
            releases.set(source.key, release)
          }
        }
        return { baseline: own.baseline, local: own.local }
      }
      if (adopted) return structuredClone(adopted)
      const rows = await transact<PendingRecord[]>('readonly', (store, result) => {
        const request = store.getAll(); request.onsuccess = () => result(request.result.filter((r: PendingRecord) => r.userId === userId && r.key !== key))
      })
      for (const candidate of rows.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''))) {
        // Without a cross-context lock, never guess that an active owner died.
        if (!navigator.locks) throw new Error('Cross-tab recovery needs Web Locks; pending edits were retained')
        const release = await lease(candidate.key)
        if (!release) continue
        try {
          const current = await get(candidate.key)
          if (!current) { release(); continue }
          const source = { key: candidate.key, stamp: await stamp(current) }
          sources.set(source.key, source); releases.set(source.key, release)
          for (const inherited of current.sources ?? []) sources.set(inherited.key, inherited)
          adopted = { baseline: current.baseline, local: current.local }
          return structuredClone(adopted)
        } catch (error) { release(); throw error }
      }
      return undefined
    }),
    save: snapshot => {
      const accepted = structuredClone(snapshot)
      return ordered(() => transact<void>('readwrite', (store, result) => {
        const record: PendingRecord = { ...accepted, version: 1, userId, key, updatedAt: new Date().toISOString(), sources: [...sources.values()] }
        store.put(record); result(undefined)
      }))
    },
    acknowledge: local => {
      const expected = JSON.stringify(local)
      return ordered(async () => {
        const own = await get(key)
        if (!own) return false
        // Validate first even for an ACK that cannot match; corrupt data is retained.
        if (JSON.stringify(own.local) !== expected) return false
        for (const source of own.sources ?? []) sources.set(source.key, source)
        const unchanged = new Map<string, string>()
        for (const source of sources.values()) {
          if (!releases.has(source.key)) {
            const release = await lease(source.key)
            if (!release) continue
            releases.set(source.key, release)
          }
          const current = await get(source.key)
          if (current && await stamp(current) === source.stamp) unchanged.set(source.key, JSON.stringify(current))
        }
        const ack = await transact<boolean>('readwrite', (store, result, fail) => {
          const request = store.get(key)
          request.onsuccess = () => {
            try {
              const current = validate(request.result)
              if (!current || JSON.stringify(current.local) !== expected) { result(false); return }
              store.delete(key)
              for (const [sourceKey, serialized] of unchanged) {
                const source = store.get(sourceKey)
                source.onsuccess = () => { if (JSON.stringify(source.result) === serialized) store.delete(sourceKey) }
              }
              result(true)
            } catch (error) { fail(error) }
          }
        })
        if (ack) releaseSources()
        return ack
      })
    },
    close: async () => {
      closing = true; await serial.catch(() => undefined); closed = true
      releaseSources(); (await ownership.catch(() => undefined))?.()
      await opened.then(db => db.close()).catch(() => undefined)
    }
  }
}
