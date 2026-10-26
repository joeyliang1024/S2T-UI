import type { Settings } from '../../../shared/types'
import { normalizeSettings, defaultHttpCapabilities, textEndpoint } from '../../../shared/services/settings'
import { activeTranslate } from '../../../shared/i18n/index'

/** Environment models are startup defaults; account profiles remain selectable. */
export const applyEnvironmentSettings = (value: Partial<Settings>, config: EnvironmentModels): Settings => {
  const current = normalizeSettings(value)
  const translationId = 'web-environment-translation'
  const asr = config.asr
  const translation = config.translation
  const profiles = current.modelProfiles.filter((profile) => profile.id !== 'environment-asr' && profile.id !== 'web-environment-asr' && !profile.id.startsWith('web-gateway-asr-'))
  const gatewayProfiles = (config.asrProfiles?.filter((profile) => profile.configured).sort((a, b) => Number(b.id === 'default') - Number(a.id === 'default')) ?? (asr?.configured && asr.endpoint && asr.model ? [{ id: 'default', name: asr.model, endpoint: asr.sourceEndpoint || asr.endpoint, model: asr.model, configured: true }] : [])).map((profile) => ({ id: profile.id === 'default' ? 'web-environment-asr' : `web-gateway-asr-${profile.id}`, name: profile.name, endpoint: profile.sourceEndpoint || profile.endpoint, model: profile.model, kind: 'openai-http' as const, capabilities: defaultHttpCapabilities }))
  profiles.unshift(...gatewayProfiles)
  const translations = current.translationProfiles.filter((profile) => !['environment-translation', 'web-environment-translation'].includes(profile.id))
  if (translation?.configured && translation.endpoint && translation.model) translations.push({ id: translationId, name: activeTranslate('stEnvironmentProfile').replace('{model}', String(translation.model)), endpoint: translation.sourceEndpoint || translation.endpoint, model: translation.model })
  const selectedModelId = value.selectedModelId !== 'none' && profiles.some(profile => profile.id === value.selectedModelId) ? value.selectedModelId! : gatewayProfiles[0]?.id ?? profiles[0]?.id ?? 'none'
  const selectedTranslationModelId = value.selectedTranslationModelId !== 'none' && translations.some(profile => profile.id === value.selectedTranslationModelId) ? value.selectedTranslationModelId! : translations[0]?.id ?? 'none'
  const activeTranslation = translations.find((profile) => profile.id === selectedTranslationModelId)
  const localDiarization = (config.diarizationProfiles ?? []).filter(profile => profile.configured).map(profile => ({ ...profile, endpoint: profile.endpoint, requiresApiKey: false }))
  const userDiarization = (current.diarizationProfiles ?? []).filter(profile => !profile.id.startsWith('local-'))
  if (current.diarizationEndpoint && !['/api/diarizations', 's2t-local://diarization', config.diarization?.endpoint].includes(current.diarizationEndpoint) && !userDiarization.some(profile => profile.model === current.diarizationModel && profile.endpoint === current.diarizationEndpoint)) userDiarization.push({ id: 'managed-diarization', name: current.diarizationModel, model: current.diarizationModel, endpoint: current.diarizationEndpoint, requiresApiKey: current.diarizationRequiresApiKey })
  return { ...current, diarizationProfiles: [...localDiarization, ...userDiarization], modelProfiles: profiles, selectedModelId,
    translationProfiles: translations, selectedTranslationModelId,
    translationEndpoint: activeTranslation?.endpoint ?? translation?.endpoint ?? textEndpoint(current.translationEndpoint), translationModel: activeTranslation?.model ?? translation?.model ?? current.translationModel,
    ...(config.summary?.configured ? { summaryEndpoint: config.summary.endpoint, summaryModel: config.summary.model, summaryRequiresApiKey: false } : {}),
    ...(config.diarization?.configured ? { diarizationEndpoint: config.diarization.endpoint, diarizationModel: config.diarization.model, diarizationRequiresApiKey: false } : {}) }
}
