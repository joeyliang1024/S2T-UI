import { type ImportCheckpoint, type LiveTranscriptDraft, type SavedSession } from '../types'

const userKey = (userId: string, name: string): string => {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(userId)) throw new Error('無效的使用者 ID')
  return `${name}:${userId}`
}

export const sessionsKey = (userId: string): string => userKey(userId, 's2t-ui.sessions.v1')

export const settingsKey = (userId: string): string => userKey(userId, 's2t-ui.settings.v1')

export const recordingsDatabase = 's2t-ui.recordings.v1'

export const recordingsStore = 'audio'

export const sessionsStore = 'sessions'

export const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

export const openRecordingsDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(recordingsDatabase, 2)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(recordingsStore)) request.result.createObjectStore(recordingsStore)
    if (!request.result.objectStoreNames.contains(sessionsStore)) request.result.createObjectStore(sessionsStore)
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

export const saveSessions = async (userId: string, sessions: SavedSession[]): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(sessionsStore, 'readwrite')
    transaction.objectStore(sessionsStore).put(sessions, userKey(userId, 'sessions'))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export const loadSessions = async (userId: string): Promise<SavedSession[] | undefined> => {
  const database = await openRecordingsDatabase()
  const sessions = await new Promise<SavedSession[] | undefined>((resolve, reject) => {
    const request = database.transaction(sessionsStore, 'readonly').objectStore(sessionsStore).get(userKey(userId, 'sessions'))
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as SavedSession[] : undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return sessions
}

const liveDraftKey = (userId: string): string => userKey(userId, 'live-draft')
const importCheckpointKey = (userId: string): string => userKey(userId, 'import-checkpoint')
export const saveLiveDraft = async (userId: string, draft: LiveTranscriptDraft): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(sessionsStore, 'readwrite')
    transaction.objectStore(sessionsStore).put(draft, liveDraftKey(userId))
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
export const loadLiveDraft = async (userId: string): Promise<LiveTranscriptDraft | undefined> => {
  const database = await openRecordingsDatabase()
  const draft = await new Promise<LiveTranscriptDraft | undefined>((resolve, reject) => {
    const request = database.transaction(sessionsStore, 'readonly').objectStore(sessionsStore).get(liveDraftKey(userId))
    request.onsuccess = () => {
      const value = request.result
      resolve(value && typeof value === 'object' && typeof value.id === 'string' && Array.isArray(value.segments) ? value as LiveTranscriptDraft : undefined)
    }
    request.onerror = () => reject(request.error)
  })
  database.close()
  return draft
}
export const deleteLiveDraft = async (userId: string): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(sessionsStore, 'readwrite')
    transaction.objectStore(sessionsStore).delete(liveDraftKey(userId))
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export const saveImportCheckpoint = async (userId: string, checkpoint: ImportCheckpoint): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(sessionsStore, 'readwrite')
    transaction.objectStore(sessionsStore).put(checkpoint, importCheckpointKey(userId))
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
export const loadImportCheckpoint = async (userId: string): Promise<ImportCheckpoint | undefined> => {
  const database = await openRecordingsDatabase()
  const checkpoint = await new Promise<ImportCheckpoint | undefined>((resolve, reject) => {
    const request = database.transaction(sessionsStore, 'readonly').objectStore(sessionsStore).get(importCheckpointKey(userId))
    request.onsuccess = () => {
      const value = request.result
      resolve(value && typeof value === 'object' && typeof value.fingerprint === 'string' && Number.isInteger(value.nextChunkIndex) && Array.isArray(value.segments) ? value as ImportCheckpoint : undefined)
    }
    request.onerror = () => reject(request.error)
  })
  database.close()
  return checkpoint
}
export const deleteImportCheckpoint = async (userId: string): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(sessionsStore, 'readwrite')
    transaction.objectStore(sessionsStore).delete(importCheckpointKey(userId))
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export const saveRecording = async (userId: string, key: string, audio: Blob): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(recordingsStore, 'readwrite')
    transaction.objectStore(recordingsStore).put(audio, userKey(userId, key))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export const loadRecording = async (userId: string, key: string): Promise<Blob | undefined> => {
  const database = await openRecordingsDatabase()
  const audio = await new Promise<Blob | undefined>((resolve, reject) => {
    const request = database.transaction(recordingsStore, 'readonly').objectStore(recordingsStore).get(userKey(userId, key))
    request.onsuccess = () => resolve(request.result as Blob | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return audio
}

export const deleteRecording = async (userId: string, key: string): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(recordingsStore, 'readwrite')
    transaction.objectStore(recordingsStore).delete(userKey(userId, key))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
