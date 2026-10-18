'use strict'

const record = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(path, '必須是物件')
  return value
}
const invalid = (path, detail) => new Error(`遠端 session 回應格式無效：${path} ${detail}`)
const string = (value, path) => {
  if (typeof value !== 'string') throw invalid(path, '必須是文字')
  return value
}
const nonEmptyString = (value, path) => {
  const result = string(value, path)
  if (!result) throw invalid(path, '不可為空')
  return result
}
const number = (value, path, { integer = false, minimum = 0 } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < minimum) throw invalid(path, `必須是${integer ? '非負安全整數' : '非負有限數字'}`)
  return value
}
const optional = (object, key, check, path) => {
  if (object[key] !== undefined) check(object[key], `${path}.${key}`)
}
const oneOf = (value, path, values) => {
  if (!values.includes(value)) throw invalid(path, `必須是 ${values.join('、')} 之一`)
  return value
}
const optionalString = (object, key, path) => optional(object, key, string, path)
const optionalBoolean = (object, key, path) => optional(object, key, value => {
  if (typeof value !== 'boolean') throw invalid(`${path}.${key}`, '必須是布林值')
}, path)
const optionalNonNegativeInteger = (object, key, path) => optional(object, key, value => number(value, `${path}.${key}`, { integer: true }), path)

const validateModelSnapshot = (value, path) => {
  const snapshot = record(value, path)
  // Settings defaults deliberately use empty strings for unconfigured model
  // fields (especially glossary prompt); the contract requires their type, not
  // a configured provider.
  for (const key of ['id', 'name', 'endpoint', 'model', 'sourceLanguage', 'prompt']) string(snapshot[key], `${path}.${key}`)
  oneOf(snapshot.kind, `${path}.kind`, ['websocket', 'openai-http'])
  if (typeof snapshot.requiresApiKey !== 'boolean') throw invalid(`${path}.requiresApiKey`, '必須是布林值')
  number(snapshot.inputSampleRate, `${path}.inputSampleRate`, { integer: true, minimum: 1 })
  number(snapshot.modelSampleRate, `${path}.modelSampleRate`, { integer: true, minimum: 1 })
  const capabilities = record(snapshot.capabilities, `${path}.capabilities`)
  oneOf(capabilities.asrMode, `${path}.capabilities.asrMode`, ['streaming', 'non-streaming'])
  oneOf(capabilities.vadSource, `${path}.capabilities.vadSource`, ['app', 'server'])
  oneOf(capabilities.timestampPrecision, `${path}.capabilities.timestampPrecision`, ['chunk', 'segment', 'word'])
  if (capabilities.supportedLanguages !== undefined) {
    if (!Array.isArray(capabilities.supportedLanguages)) throw invalid(`${path}.capabilities.supportedLanguages`, '必須是陣列')
    capabilities.supportedLanguages.forEach((item, index) => nonEmptyString(item, `${path}.capabilities.supportedLanguages[${index}]`))
  }
  if (capabilities.supportedSampleRates !== undefined) {
    if (!Array.isArray(capabilities.supportedSampleRates)) throw invalid(`${path}.capabilities.supportedSampleRates`, '必須是陣列')
    capabilities.supportedSampleRates.forEach((item, index) => number(item, `${path}.capabilities.supportedSampleRates[${index}]`, { integer: true, minimum: 1 }))
  }
}

const validateSegment = (value, path) => {
  const segment = record(value, path)
  nonEmptyString(segment.id, `${path}.id`)
  number(segment.revision, `${path}.revision`, { integer: true })
  oneOf(segment.status, `${path}.status`, ['partial', 'final', 'gap'])
  const start = number(segment.startMs, `${path}.startMs`)
  const end = number(segment.endMs, `${path}.endMs`)
  if (end < start) throw invalid(`${path}.endMs`, '不可小於 startMs')
  string(segment.sourceText, `${path}.sourceText`)
  optionalNonNegativeInteger(segment, 'asrRevision', path)
  optionalString(segment, 'captionGroupId', path)
  optionalString(segment, 'correctionOriginalText', path)
  optionalString(segment, 'translatedText', path)
  optionalString(segment, 'speaker', path)
  optionalBoolean(segment, 'speakerManuallyEdited', path)
  if (segment.translationStatus !== undefined) oneOf(segment.translationStatus, `${path}.translationStatus`, ['failed', 'completed'])
  optionalNonNegativeInteger(segment, 'translationAttempts', path)
  optionalNonNegativeInteger(segment, 'translationContentRevision', path)
  optionalBoolean(segment, 'isSentenceBoundary', path)
  optionalBoolean(segment, 'boundaryOnly', path)
  if (segment.detectedLanguage !== undefined) oneOf(segment.detectedLanguage, `${path}.detectedLanguage`, ['zh-TW', 'en-US', 'ja-JP', 'de-DE'])
  if (segment.gapReason !== undefined) oneOf(segment.gapReason, `${path}.gapReason`, ['queue-overflow', 'request-failed'])
}
const validateSegments = (value, path) => {
  if (!Array.isArray(value)) throw invalid(path, '必須是陣列')
  value.forEach((segment, index) => validateSegment(segment, `${path}[${index}]`))
}

const validateAudioVersion = (value, path) => {
  const version = record(value, path)
  for (const key of ['id', 'audioKey', 'createdAt', 'label']) nonEmptyString(version[key], `${path}.${key}`)
  optionalString(version, 'parentId', path)
  optionalString(version, 'replacedSegmentId', path)
  optionalString(version, 'nativeAudioPath', path)
  optionalString(version, 'transcript', path)
  if (version.segments !== undefined) validateSegments(version.segments, `${path}.segments`)
  if (version.modelSnapshot !== undefined) validateModelSnapshot(version.modelSnapshot, `${path}.modelSnapshot`)
}

const validateSession = (value, path) => {
  const session = record(value, path)
  for (const key of ['id', 'title', 'createdAt', 'source', 'transcript']) string(session[key], `${path}.${key}`)
  // A few pre-audio archival records have no audioKey at all. Normalize only
  // that legacy omission to the existing no-audio representation; otherwise a
  // corrupt type still fails before the caller can save over it.
  if (session.audioKey !== undefined) string(session.audioKey, `${path}.audioKey`)
  number(session.durationMs, `${path}.durationMs`)
  validateSegments(session.segments, `${path}.segments`)
  if (session.audioVersions !== undefined) {
    if (!Array.isArray(session.audioVersions)) throw invalid(`${path}.audioVersions`, '必須是陣列')
    session.audioVersions.forEach((version, index) => validateAudioVersion(version, `${path}.audioVersions[${index}]`))
  }
  optionalString(session, 'activeAudioVersionId', path)
  optionalString(session, 'nativeAudioPath', path)
  optionalBoolean(session, 'savedToDisk', path)
  optionalBoolean(session, 'audioUnavailable', path)
  if (session.modelSnapshot !== undefined) validateModelSnapshot(session.modelSnapshot, `${path}.modelSnapshot`)
  if (session.processingState !== undefined) oneOf(session.processingState, `${path}.processingState`, ['running', 'completed', 'failed'])
  if (session.processingStage !== undefined) oneOf(session.processingStage, `${path}.processingStage`, ['asr', 'translation', 'saving', 'diarization'])
  optionalBoolean(session, 'recoveryFullAsr', path)
  if (session.processingFailures !== undefined) {
    if (!Array.isArray(session.processingFailures)) throw invalid(`${path}.processingFailures`, '必須是陣列')
    session.processingFailures.forEach((stage, index) => oneOf(stage, `${path}.processingFailures[${index}]`, ['asr', 'translation', 'saving', 'diarization']))
  }
  for (const key of ['processingToken', 'processingError', 'diarizationJobId', 'qualityCorrectionError', 'summary', 'summaryError', 'summarySourceSignature', 'summarySourceVersionId', 'summaryTranslation', 'summaryTranslationTargetLanguage']) optionalString(session, key, path)
  if (session.qualityCorrectionState !== undefined) oneOf(session.qualityCorrectionState, `${path}.qualityCorrectionState`, ['completed', 'failed'])
  if (session.summaryState !== undefined) oneOf(session.summaryState, `${path}.summaryState`, ['generating', 'interrupted'])
}

const parseSessionsResponse = value => {
  const body = record(value, 'response')
  if (!Array.isArray(body.sessions)) throw invalid('response.sessions', '必須是陣列')
  number(body.version, 'response.version', { integer: true })
  body.sessions.forEach((session, index) => validateSession(session, `response.sessions[${index}]`))
  const sessions = body.sessions.map(session => session.audioKey === undefined ? { ...session, audioKey: '' } : session)
  return { sessions, version: body.version }
}
const parseLiveDraftResponse = value => {
  const body = record(value, 'response')
  if (body.value === undefined || body.value === null) return undefined
  const draft = record(body.value, 'response.value')
  for (const key of ['id', 'startedAt', 'updatedAt', 'source']) nonEmptyString(draft[key], `response.value.${key}`)
  oneOf(draft.captureState, 'response.value.captureState', ['recording', 'paused'])
  number(draft.elapsedMs, 'response.value.elapsedMs')
  validateSegments(draft.segments, 'response.value.segments')
  optionalString(draft, 'opfsRecordingId', 'response.value')
  if (draft.sampleRate !== undefined) number(draft.sampleRate, 'response.value.sampleRate', { integer: true, minimum: 1 })
  return draft
}
const parseImportCheckpointResponse = value => {
  const body = record(value, 'response')
  if (body.value === undefined || body.value === null) return undefined
  const checkpoint = record(body.value, 'response.value')
  for (const key of ['fingerprint', 'modelId', 'modelSnapshot', 'sourceLanguage', 'prompt', 'mergedText', 'updatedAt']) string(checkpoint[key], `response.value.${key}`)
  number(checkpoint.nextChunkIndex, 'response.value.nextChunkIndex', { integer: true })
  number(checkpoint.nextByteOffset, 'response.value.nextByteOffset', { integer: true })
  number(checkpoint.totalChunks, 'response.value.totalChunks', { integer: true })
  if (checkpoint.nextChunkIndex > checkpoint.totalChunks) throw invalid('response.value.nextChunkIndex', '不可大於 totalChunks')
  validateSegments(checkpoint.segments, 'response.value.segments')
  return checkpoint
}

module.exports = { parseSessionsResponse, parseLiveDraftResponse, parseImportCheckpointResponse }
