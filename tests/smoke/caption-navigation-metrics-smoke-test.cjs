const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const samples = [], listeners = {}
const saved = { document: global.document, window: global.window, metricSamples: global.metricSamples, performance: global.performance }
global.document = { visibilityState: 'visible', addEventListener: (name, handler) => { listeners[name] = handler } }
let now = -1; global.performance = { now: () => now };
global.window = {}; global.metricSamples = samples
const source = fs.readFileSync('src/renderer/src/shared/services/caption-metrics.ts', 'utf8')
  .replace(/import .* from '\.\/caption-metric-transport'/, 'class CaptionMetricTransport { constructor(sender: unknown) {} enqueue(samples: unknown[]) { globalThis.metricSamples.push(...samples) } } type CaptionMetricSample = {stage: string; seconds: number}')
  .replace(/import .* from .*auth-client'/, 'const authFetch = async () => ({ok: true})')
const code = buildSync({ stdin: { contents: source, loader: 'ts' }, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const moduleLoaded = { exports: {} }; new Function('module', 'exports', code)(moduleLoaded, moduleLoaded.exports)
const m = moduleLoaded.exports
const timing = { chunkSpeechAt: 0, chunkDetectedAt: 100, queuedAt: 500, dequeuedAt: 550, requestAt: 560, responseAt: 1000 }
const register = id => { const event = {}; m.attachCaptionTiming(event, timing); m.registerCaptionTiming(id, event) }
try {
  m.setCaptionMeasurementActive(true); register('normal'); m.reportCaptionPaint(['normal'], 1020)
  assert.equal(samples.find(x => x.stage === 'response_to_paint').seconds, .02)
  assert.equal(samples.find(x => x.stage === 'chunk_speech_to_paint').seconds, 1.02)
  const before = samples.length
  register('leave'); m.setCaptionMeasurementActive(false); m.setCaptionMeasurementActive(true); m.reportCaptionPaint(['leave'], 100000)
  assert.equal(samples.length, before + 3, 'arrival stages recorded; navigation cannot create a delayed paint')
  m.setCaptionMeasurementActive(false); register('away'); m.setCaptionMeasurementActive(true); m.reportCaptionPaint(['away'], 100000)
  assert.equal(samples.length, before + 3)
  register('hidden'); document.visibilityState = 'hidden'; listeners.visibilitychange(); document.visibilityState = 'visible'; listeners.visibilitychange(); m.reportCaptionPaint(['hidden'], 100000)
  assert.equal(samples.length, before + 6)
  register('offscreen'); m.discardCaptionPaint(['offscreen']); m.reportCaptionPaint(['offscreen'], 100000)
  assert.equal(samples.length, before + 9)
  m.registerTranslationTiming('translation', 1000, 1100); m.setCaptionMeasurementActive(false); m.setCaptionMeasurementActive(true); m.reportTranslationPaint(['translation'], 100000)
  assert.equal(samples.length, before + 9)
  assert.equal(samples.filter(x => x.stage === 'response_to_paint').length, 1)
  assert.equal(samples.filter(x => x.stage === 'asr_roundtrip_with_retries').length, 4)
  // Requests may resolve after returning: clearing pending maps alone is insufficient.
  now = 2000; m.setCaptionMeasurementActive(false); now = 5000; m.setCaptionMeasurementActive(true)
  const arrivalCount = samples.filter(x => x.stage === 'asr_roundtrip_with_retries').length
  const paints = samples.filter(x => x.stage === 'response_to_paint').length
  const crossing = {}; m.attachCaptionTiming(crossing, { ...timing, responseAt: 5100 })
  m.registerCaptionTiming('crossing-navigation', crossing); m.reportCaptionPaint(['crossing-navigation'], 5120)
  now = 6000; document.visibilityState = 'hidden'; listeners.visibilitychange()
  now = 9000; document.visibilityState = 'visible'; listeners.visibilitychange()
  const hiddenRequest = {}; m.attachCaptionTiming(hiddenRequest, { ...timing, chunkSpeechAt: 5500, queuedAt: 5900, responseAt: 9100 })
  m.registerCaptionTiming('crossing-hidden', hiddenRequest); m.reportCaptionPaint(['crossing-hidden'], 9120)
  m.registerTranslationTiming('crossing-translation', 5900, 9100); m.reportTranslationPaint(['crossing-translation'], 9120)
  assert.equal(samples.filter(x => x.stage === 'response_to_paint').length, paints)
  assert.equal(samples.filter(x => x.stage === 'translation_roundtrip').length, 0)
  assert.equal(samples.filter(x => x.stage === 'asr_roundtrip_with_retries').length, arrivalCount)
  const fresh = {}; m.attachCaptionTiming(fresh, { chunkSpeechAt: 9100, chunkDetectedAt: 9200, queuedAt: 9500, dequeuedAt: 9550, requestAt: 9560, responseAt: 10000 })
  m.registerCaptionTiming('fresh', fresh); m.reportCaptionPaint(['fresh'], 10020)
  assert.equal(samples.filter(x => x.stage === 'response_to_paint').length, paints + 1)
  assert.equal(samples.filter(x => x.stage === 'chunk_speech_to_paint').at(-1).seconds, .92)
  console.log('PASS navigation, hidden tabs, offscreen captions and translation remounts never replay stale paints; cross-boundary fetch callbacks excluded as well as paints')
} finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete global[key]; else global[key] = value } }
