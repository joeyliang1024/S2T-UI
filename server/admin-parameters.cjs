const bounds = {
  minSpeechMs: [40, 2000], minSilenceMs: [50, 5000], preRollMs: [0, 1000], noiseFloorOffsetDb: [3, 40],
  chunkMinMs: [200, 6000], chunkMaxMs: [200, 6000],
  translationAggregationMs: [0, 2000], translationThrottledMs: [100, 10000],
  translationSentenceWaitMs: [0, 15000], translationConcurrency: [1, 4], translationTemperature: [0, 2]
}
function validateAdminParameters(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('進階參數必須是物件')
  const result = {}
  for (const [key, number] of Object.entries(value)) {
    const range = Object.prototype.hasOwnProperty.call(bounds, key) ? bounds[key] : undefined
    if (!range || typeof number !== 'number' || !Number.isFinite(number) || number < range[0] || number > range[1] || (key !== 'translationTemperature' && !Number.isInteger(number))) throw new Error(`進階參數 ${key} 無效`)
    result[key] = number
  }
  if ((result.chunkMinMs !== undefined || result.chunkMaxMs !== undefined) && (result.chunkMinMs ?? 700) > (result.chunkMaxMs ?? 1500)) throw new Error('chunkMinMs 不可大於 chunkMaxMs')
  if ((result.minSpeechMs ?? 120) > (result.chunkMaxMs ?? 1500)) throw new Error('語音確認時間不可長於 chunk 上限')
  return result
}
module.exports = { bounds, validateAdminParameters }
