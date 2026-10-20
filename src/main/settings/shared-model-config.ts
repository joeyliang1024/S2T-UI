import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { modelSettingsKeys, preserveModelSettings } from '../../shared/validation/model-settings.cjs'

type Config = Record<string, unknown>
export const readConfig = async (path: string): Promise<Config> => {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('無效的模型設定')
    return value as Config
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
export const writeConfig = async (path: string, config: Config): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export const loadSharedModelConfig = async (personalPath: string, sharedPath: string, admin: boolean): Promise<Config> => {
  const personal = await readConfig(personalPath)
  let shared = await readConfig(sharedPath)
  if (admin && !Object.keys(shared).length) {
    shared = Object.fromEntries(modelSettingsKeys.filter(key => Object.hasOwn(personal, key)).map(key => [key, personal[key]]))
    if (Object.keys(shared).length) await writeConfig(sharedPath, shared)
  }
  return preserveModelSettings(personal, shared)
}
export const saveSharedModelConfig = async (personalPath: string, sharedPath: string, input: Config, admin: boolean): Promise<Config> => {
  const shared = await readConfig(sharedPath)
  const config = admin ? input : preserveModelSettings(input, shared)
  if (admin) await writeConfig(sharedPath, Object.fromEntries(modelSettingsKeys.filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]])))
  await writeConfig(personalPath, config)
  return config
}

const destination = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return ''
    url.pathname = url.pathname.replace(/\/(audio\/transcriptions|chat\/completions)\/?$/, '').replace(/\/$/, '')
    return url.toString().replace(/\/$/, '')
  } catch { return '' }
}
/** Credentials can only leave Main for the exact destination saved by admin. */
export const matchesModelDestination = (config: Config, id: string, endpoint: string, model: string): boolean => {
  const profiles = [...(Array.isArray(config.modelProfiles) ? config.modelProfiles : []), ...(Array.isArray(config.translationProfiles) ? config.translationProfiles : [])]
  for (const purpose of ['translation', 'summary', 'diarization']) profiles.push({ id: purpose, endpoint: config[`${purpose}Endpoint`], model: config[`${purpose}Model`] })
  const target = destination(endpoint)
  return Boolean(target && profiles.some(profile => profile?.id === id && profile.model === model && destination(profile.endpoint) === target))
}
