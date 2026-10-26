import type { Dispatch, SetStateAction } from 'react'
import type { Settings, CaptureState, SavedSession } from '../../../shared/types'

/** The settings screen receives only the state and commands it presents. */
export interface SettingsViewModel {
  settings: Settings
  setSettings: Dispatch<SetStateAction<Settings>>
  setStatus: (message: string) => void
  saveSettings: () => void
  settingsSaved: boolean
  captureState: CaptureState
  denoiseApplied: boolean | null
  browserRecordingStorage: 'opfs' | 'memory' | 'electron'
  remoteSessionSyncState: 'ready' | 'syncing' | 'paused'
  storageHealth: { mode: { blob: string; config: string; vector: string }; schemaVersion: string; ready: boolean } | null
  audioMigrationStatus: { copied: number; pending: number } | null
  storageCompensations: { audioPending: number; voiceprintPending: number } | null
  storageOrphanAudio: number | null
  sileroVadAvailable: boolean | null
  modelHealth: Record<string, { state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; reason: string; checkedAt: number }>
  remoteSessionConflicts: Array<{ id: string; local?: SavedSession; remote?: SavedSession }>
  retryRemoteSessionSync: () => Promise<void>
  retryStorageCompensations: () => Promise<void>
  cleanOrphanAudio: () => Promise<void>
  resolveSessionConflict: (id: string, choice: 'local' | 'remote') => Promise<void>
}
