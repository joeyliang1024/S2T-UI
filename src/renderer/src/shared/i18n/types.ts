export const supportedUiLanguages = ['zh-TW', 'zh-CN', 'en', 'ja', 'de'] as const
export type UiLanguage = typeof supportedUiLanguages[number]
