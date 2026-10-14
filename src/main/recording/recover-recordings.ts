import { open, rm, stat } from 'node:fs/promises'

export type RecoverableRecording = {
  id: string
  path: string
  sampleRate: number
  createdAt: string
  state: 'active' | 'finished'
}

export type RecoveredRecording = RecoverableRecording & { audioPath: string }

type OpenedRecoveryFile = { write: (buffer: Uint8Array, position: number) => Promise<unknown>; close: () => Promise<void> }

export type RecoveryFileOperations = {
  stat: (path: string) => Promise<{ size: number }>
  open: (path: string, flags: string) => Promise<OpenedRecoveryFile>
  remove: (path: string) => Promise<void>
}

export type RecordingRecoveryDependencies = {
  read: () => Promise<RecoverableRecording[]>
  update: (update: (entries: RecoverableRecording[]) => RecoverableRecording[]) => Promise<void>
  isActive: (entry: RecoverableRecording) => boolean
  isAllowedPath: (path: string) => boolean
  header: (sampleRate: number, dataBytes: number) => Uint8Array
  recovered: (entry: RecoverableRecording) => void
  files?: Partial<RecoveryFileOperations>
}

const defaultFiles: RecoveryFileOperations = {
  stat,
  open: (path, flags) => open(path, flags),
  remove: path => rm(path, { force: true })
}

const sameSource = (left: RecoverableRecording, right: RecoverableRecording): boolean =>
  left.id === right.id && left.path === right.path && left.sampleRate === right.sampleRate && left.createdAt === right.createdAt

const filesFor = (files?: Partial<RecoveryFileOperations>): RecoveryFileOperations => ({ ...defaultFiles, ...files })

/**
 * Repairs only sources that are no longer admitted for writing. Every manifest
 * update is a narrow transition so unreadable sources and concurrent additions
 * remain available for a later recovery attempt.
 */
export const recoverRecordings = async (dependencies: RecordingRecoveryDependencies): Promise<RecoveredRecording[]> => {
  const entries = await dependencies.read()
  const files = filesFor(dependencies.files)
  const recovered: RecoveredRecording[] = []

  for (const entry of entries) {
    if (dependencies.isActive(entry) || !dependencies.isAllowedPath(entry.path)) continue
    try {
      const info = await files.stat(entry.path)
      if (info.size <= 44 || dependencies.isActive(entry)) continue
      const file = await files.open(entry.path, 'r+')
      try {
        if (dependencies.isActive(entry)) continue
        await file.write(dependencies.header(entry.sampleRate, info.size - 44), 0)
      } finally {
        await file.close()
      }
      dependencies.recovered(entry)
      recovered.push({ ...entry, audioPath: entry.path })
    } catch {
      // Keep the manifest entry: a temporary storage error is recovery evidence.
    }
  }

  if (recovered.length) {
    await dependencies.update(current => current.map(entry => {
      const completed = recovered.find(candidate => sameSource(candidate, entry))
      return completed && !dependencies.isActive(entry) && dependencies.isAllowedPath(entry.path)
        ? { ...entry, state: 'finished' }
        : entry
    }))
  }
  return recovered
}

/** Remove only the exact, inactive manifest source selected by the trusted caller. */
export const discardRecoverableRecording = async (id: string, dependencies: Omit<RecordingRecoveryDependencies, 'header' | 'recovered'>): Promise<void> => {
  const entries = await dependencies.read()
  const target = entries.find(entry => entry.id === id)
  if (!target || dependencies.isActive(target) || !dependencies.isAllowedPath(target.path)) return

  const files = filesFor(dependencies.files)
  await files.remove(target.path)
  await dependencies.update(current => current.filter(entry =>
    !sameSource(entry, target) || dependencies.isActive(entry) || !dependencies.isAllowedPath(entry.path)
  ))
}
