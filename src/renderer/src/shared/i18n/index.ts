export const supportedUiLanguages = ['zh-TW', 'zh-CN', 'en', 'ja', 'de'] as const
export type UiLanguage = typeof supportedUiLanguages[number]

const messages = {
  'zh-TW': { appName: '即時語音字幕', live: '即時字幕', history: '記錄', import: '匯入檔案', models: '模型管理', voiceprints: '聲紋管理', settings: '設定', logout: '登出', menu: '功能選單' },
  'zh-CN': { appName: '实时语音字幕', live: '实时字幕', history: '记录', import: '导入文件', models: '模型管理', voiceprints: '声纹管理', settings: '设置', logout: '退出登录', menu: '功能菜单' },
  en: { appName: 'Live Speech Captions', live: 'Live captions', history: 'History', import: 'Import files', models: 'Model management', voiceprints: 'Voiceprints', settings: 'Settings', logout: 'Sign out', menu: 'Menu' },
  ja: { appName: 'リアルタイム字幕', live: 'ライブ字幕', history: '履歴', import: 'ファイルを読み込む', models: 'モデル管理', voiceprints: '声紋管理', settings: '設定', logout: 'ログアウト', menu: 'メニュー' },
  de: { appName: 'Live-Sprachuntertitel', live: 'Live-Untertitel', history: 'Verlauf', import: 'Datei importieren', models: 'Modellverwaltung', voiceprints: 'Stimmabdrücke', settings: 'Einstellungen', logout: 'Abmelden', menu: 'Menü' }
} as const

export type MessageKey = keyof typeof messages['zh-TW']
export const translate = (language: UiLanguage, key: MessageKey): string => messages[language][key]
