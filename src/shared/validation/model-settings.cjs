const modelSettingsKeys = Object.freeze(['selectedModelId', 'selectedTranslationModelId', 'modelProfiles', 'translationProfiles', 'diarizationProfiles', 'summaryEndpoint', 'summaryModel', 'summaryRequiresApiKey', 'diarizationEndpoint', 'diarizationModel', 'diarizationRequiresApiKey', 'embeddingEndpoint', 'embeddingModel', 'embeddingRequiresApiKey', 'translationEndpoint', 'translationModel', 'translationRequiresApiKey'])
const preserveModelSettings = (input, saved) => {
  const result = { ...input }
  for (const key of modelSettingsKeys) {
    if (Object.hasOwn(saved || {}, key)) result[key] = saved[key]
    else delete result[key]
  }
  return result
}
module.exports = { modelSettingsKeys, preserveModelSettings }
