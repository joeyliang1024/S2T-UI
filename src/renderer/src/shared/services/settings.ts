import { type Settings, type ModelCapabilities, type ModelProfile, type TextModelProfile } from '../types'
import { supportedUiLanguages } from '../i18n'
import { settingsKey, loadJson } from './browser-storage'
import { defaultVadConfig } from '../../features/capture/vad'

export const modelEndpoint = (endpoint: string, kind: ModelProfile['kind']): string => {
  try {
    const url = new URL(endpoint.trim())
    const withoutKnownResource = url.pathname.replace(/\/(audio\/transcriptions|chat\/completions|realtime)\/?$/, '').replace(/\/$/, '')
    if (kind === 'openai-http') {
      url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
      url.pathname = `${withoutKnownResource || ''}/v1/audio/transcriptions`.replace(/\/v1\/v1\//, '/v1/')
    } else {
      url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol
      url.pathname = `${withoutKnownResource || ''}/v1/realtime`.replace(/\/v1\/v1\//, '/v1/')
    }
    return url.toString()
  } catch {
    return endpoint.trim()
  }
}

export const defaultWebSocketCapabilities: ModelCapabilities = { asrMode: 'streaming', vadSource: 'server', timestampPrecision: 'segment' }

export const defaultHttpCapabilities: ModelCapabilities = { asrMode: 'non-streaming', vadSource: 'app', timestampPrecision: 'chunk' }

export const defaultModelProfile: ModelProfile = { id: 'none', name: '未連接模型', endpoint: '', model: '', kind: 'websocket', capabilities: defaultWebSocketCapabilities }

export const defaultSummaryTemplate = '# 會議摘要\n\n## 重點\n\n## 決策\n\n## 待辦事項\n'

export const supportedSourceLanguages = ['auto', 'zh-TW', 'en-US', 'ja-JP', 'de-DE'] as const
export const supportedTargetLanguages = ['zh-TW', 'en', 'ja', 'de'] as const

export const languageName = (value: string): string => ({ auto: '自動偵測', 'zh-TW': '繁體中文', 'en-US': '英文', en: '英文', 'ja-JP': '日文', ja: '日文', 'de-DE': '德文', de: '德文' }[value] ?? value)

/** OpenAI-compatible ASR detects the source language when this value is absent. */
export const asrLanguage = (value: string): string => ({ 'zh-TW': 'zh', 'en-US': 'en', 'ja-JP': 'ja', 'de-DE': 'de' }[value] ?? '')

export const normalizeSettings = (value: Partial<Settings> & { modelEndpoint?: string }): Settings => {
  const fallbackTranslationProfile: TextModelProfile[] = value.translationEndpoint && value.translationModel
    ? [{ id: 'translation-default', name: `${value.translationModel}（翻譯）`, endpoint: value.translationEndpoint, model: value.translationModel }]
    : []
  const translationProfiles = value.translationProfiles?.length ? value.translationProfiles : fallbackTranslationProfile
  return {
  theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
  uiLanguage: supportedUiLanguages.includes(value.uiLanguage as typeof supportedUiLanguages[number]) ? value.uiLanguage! : 'zh-TW',
  storageLocation: value.storageLocation === 'remote' ? 'remote' : 'local',
  sourceLanguage: supportedSourceLanguages.includes(value.sourceLanguage as typeof supportedSourceLanguages[number]) ? value.sourceLanguage! : 'zh-TW',
  targetLanguage: supportedTargetLanguages.includes(value.targetLanguage as typeof supportedTargetLanguages[number]) ? value.targetLanguage! : 'en',
  translationEnabled: value.translationEnabled ?? true,
  translationStrategy: value.translationStrategy === 'sentence' ? 'sentence' : 'realtime',
  modelProfiles: value.modelProfiles?.length ? value.modelProfiles.map((profile) => ({ ...profile, model: profile.model ?? '', kind: profile.kind ?? 'websocket', capabilities: profile.capabilities ?? (profile.kind === 'openai-http' ? defaultHttpCapabilities : defaultWebSocketCapabilities) })) : [{ ...defaultModelProfile, endpoint: value.modelEndpoint ?? '' }],
  selectedModelId: value.selectedModelId ?? value.modelProfiles?.[0]?.id ?? 'none',
  translationEndpoint: value.translationEndpoint ?? '',
  translationModel: value.translationModel ?? '',
  translationProfiles,
  selectedTranslationModelId: value.selectedTranslationModelId ?? translationProfiles[0]?.id ?? 'none',
  summaryEndpoint: value.summaryEndpoint ?? '',
  summaryModel: value.summaryModel ?? '',
  summaryTemplate: value.summaryTemplate?.trim() || defaultSummaryTemplate,
  summaryOutputLanguage: supportedTargetLanguages.includes(value.summaryOutputLanguage as typeof supportedTargetLanguages[number]) ? value.summaryOutputLanguage! : 'zh-TW',
  summaryIncludeTranslation: value.summaryIncludeTranslation === true,
  diarizationEndpoint: value.diarizationEndpoint ?? '',
  diarizationModel: value.diarizationModel ?? '',
  glossary: value.glossary ?? '',
  denoiseEnabled: value.denoiseEnabled !== false,
  vadConfig: { ...defaultVadConfig, ...value.vadConfig }
  }
}

export const initialSettings = (userId: string): Settings => normalizeSettings(loadJson<Partial<Settings> & { modelEndpoint?: string }>(settingsKey(userId), {}))

export const textEndpoint = (endpoint: string): string => {
  if (endpoint.startsWith('/api/')) return endpoint
  try {
    const url = new URL(endpoint)
    url.pathname = url.pathname.replace(/\/(audio\/transcriptions|chat\/completions|responses)\/?$/, '').replace(/\/$/, '') + '/chat/completions'
    return url.toString()
  } catch { return endpoint }
}
