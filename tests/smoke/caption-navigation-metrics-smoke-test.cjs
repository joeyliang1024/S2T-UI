const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const samples = [], listeners = {}
const saved = { document: global.document, window: global.window, metricSamples: global.metricSamples }
global.document = { visibilityState: 'visible', addEventListener: (name, handler) => { listeners[name] = handler } }
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
  assert.equal(samples.length, before + 6)
  register('hidden'); document.visibilityState = 'hidden'; listeners.visibilitychange(); document.visibilityState = 'visible'; m.reportCaptionPaint(['hidden'], 100000)
  assert.equal(samples.length, before + 9)
  register('offscreen'); m.discardCaptionPaint(['offscreen']); m.reportCaptionPaint(['offscreen'], 100000)
  assert.equal(samples.length, before + 12)
  m.registerTranslationTiming('translation', 1000, 1100); m.setCaptionMeasurementActive(false); m.setCaptionMeasurementActive(true); m.reportTranslationPaint(['translation'], 100000)
  assert.equal(samples.length, before + 12)
  assert.equal(samples.filter(x => x.stage === 'response_to_paint').length, 1)
  assert.equal(samples.filter(x => x.stage === 'asr_roundtrip_with_retries').length, 5)
  console.log('PASS navigation, hidden tabs, offscreen captions and translation remounts never replay stale paints; arrival metrics end at receipt')
} finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete global[key]; else global[key] = value } }
