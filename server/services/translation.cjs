const { renderPrompt } = require('../prompts.cjs')
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
const createTranslationPrompt = (text, sourceLanguage, targetLanguage, glossary, format) => {
  const chinese = isChineseLanguage(sourceLanguage) || isChineseLanguage(targetLanguage)
  return renderPrompt(chinese ? 'gatewayTranslationZh' : 'gatewayTranslationEn', {
    target: languageName(targetLanguage), source: languageName(sourceLanguage), text,
    terms: glossary ? renderPrompt('gatewayTerms', { glossary }) : '',
    structure: format === 'markdown' ? '\n' + renderPrompt(chinese ? 'gatewayMarkdownZh' : 'gatewayMarkdownEn') : ''
  })
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
