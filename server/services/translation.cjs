const languageNames = {
  auto: '自动检测（中文、英语、日语或德语）',
  'zh-TW': '繁体中文',
  'zh-CN': '简体中文',
  'en-US': '英语',
  en: '英语',
  'ja-JP': '日语',
  ja: '日语',
  'de-DE': '德语',
  de: '德语'
}
// zh-CN is a valid source: the renderer translates summaries written in the
// system UI language, which may be Simplified Chinese.
const supportedSourceLanguages = new Set(['auto', 'zh-TW', 'zh-CN', 'en-US', 'ja-JP', 'de-DE'])
const supportedTargetLanguages = new Set(['zh-TW', 'en', 'ja', 'de'])

const languageName = (value) => languageNames[value] || '自动检测（中文、英语、日语或德语）'
const isChineseLanguage = (value) => /^zh/.test(value)
const markdownFormatHint = (sourceLanguage, targetLanguage) => isChineseLanguage(sourceLanguage) || isChineseLanguage(targetLanguage)
  ? '输入为 Markdown，保留标题、列表、表格与代码块等结构，只翻译文字内容。'
  : 'The input is Markdown: keep headings, lists, tables and code blocks intact and translate only the prose.'
const createTranslationPrompt = (text, sourceLanguage, targetLanguage, glossary, format) => {
  const terms = glossary ? `\n术语表：${glossary}` : ''
  const structure = format === 'markdown' ? `\n${markdownFormatHint(sourceLanguage, targetLanguage)}` : ''
  return isChineseLanguage(sourceLanguage) || isChineseLanguage(targetLanguage)
    ? `以下输入只会是中文、英语、日语或德语。将其翻译为${languageName(targetLanguage)}；来源语言为${languageName(sourceLanguage)}。只输出译文，不要额外解释。${structure}${terms}\n\n${text}`
    : `The input is Chinese, English, Japanese, or German. Translate it into ${languageName(targetLanguage)}. The source language is ${languageName(sourceLanguage)}. Return only the translation.${structure}${terms}\n\n${text}`
}

const normalizeTranslationInput = (input) => {
  const requestedSourceLanguage = typeof input?.sourceLanguage === 'string' ? input.sourceLanguage.slice(0, 60) : 'zh-TW'
  const requestedTargetLanguage = typeof input?.targetLanguage === 'string' ? input.targetLanguage.slice(0, 60) : 'en'
  return {
    text: typeof input?.text === 'string' ? input.text.trim().slice(0, 20_000) : '',
    sourceLanguage: supportedSourceLanguages.has(requestedSourceLanguage) ? requestedSourceLanguage : 'zh-TW',
    targetLanguage: supportedTargetLanguages.has(requestedTargetLanguage) ? requestedTargetLanguage : 'en',
    glossary: typeof input?.glossary === 'string' ? input.glossary.trim().slice(0, 10_000) : '',
    format: input?.format === 'markdown' ? 'markdown' : 'text'
  }
}

const createTranslationService = ({ completeText, measure, withCapacity, logger, now = () => performance.now() }) => ({
  normalizeInput: normalizeTranslationInput,
  logRequest ({ profileId, input }) {
    // The source text and glossary stay out of the console; sizes and the
    // language pair are enough to follow a slow or failing translation.
    logger.debug('translation.request', { profileId, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, format: input.format, glossary: input.glossary ? 'provided' : 'none', chars: input.text.length })
  },
  async translate ({ selectedTranslation, user, profileId, input, temperature }) {
    const capacityStartedAt = now()
    let modelMs = 0
    const text = await withCapacity('translation', async () => {
      const modelStartedAt = now()
      try {
        return await measure('translation_model', () => completeText(
          selectedTranslation,
          [{ role: 'user', content: createTranslationPrompt(input.text, input.sourceLanguage, input.targetLanguage, input.glossary, input.format) }],
          0,
          temperature,
          { userId: user.id, operation: 'translations' }
        ))
      } finally { modelMs = now() - modelStartedAt }
    })
    return { text, modelMs, queueMs: Math.max(0, now() - capacityStartedAt - modelMs) }
  }
})

module.exports = { createTranslationService, createTranslationPrompt, normalizeTranslationInput }
