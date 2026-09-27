import type { ImportCheckpoint } from '../../shared/types'

export const importFileFingerprint = (file: Pick<File, 'name' | 'size' | 'lastModified'>): string => `${file.name}:${file.size}:${file.lastModified}`

export const importModelSnapshot = (model: { id: string; endpoint: string; model: string; capabilities: unknown }): string => JSON.stringify({ id: model.id, endpoint: model.endpoint, model: model.model, capabilities: model.capabilities })

export const matchesImportCheckpoint = (checkpoint: ImportCheckpoint | undefined, input: { fingerprint: string; modelId: string; modelSnapshot: string; sourceLanguage: string; prompt: string; totalChunks: number }): checkpoint is ImportCheckpoint => Boolean(checkpoint && checkpoint.fingerprint === input.fingerprint && checkpoint.modelId === input.modelId && checkpoint.modelSnapshot === input.modelSnapshot && checkpoint.sourceLanguage === input.sourceLanguage && checkpoint.prompt === input.prompt && checkpoint.totalChunks === input.totalChunks && checkpoint.nextChunkIndex >= 0 && checkpoint.nextChunkIndex <= input.totalChunks && checkpoint.nextByteOffset >= 0)
