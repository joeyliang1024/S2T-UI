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
  .replace(/import .* from .*(?:auth-client|authenticated-client)'/, 'const authFetch = async () => ({ok: true})')
const code = buildSync({ stdin: { contents: source, loader: 'ts' }, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const moduleLoaded = { exports: {} }; new Function('module', 'exports', code)(moduleLoaded, moduleLoaded.exports)
const m = moduleLoaded.exports
const count = stage => samples.filter(x => x.stage === stage).length
// 無 Server-Timing／無 postEndAt 的舊型 timing：抵達時記錄 t2、t1 與整段往返
// （fallback 全歸 t5_network）；繪出時才補 t5_paint 與 e2e_asr。
const ARRIVAL = ['t2_vad', 't1_queue', 't1_encode', 't5_network']
const timing = { chunkSpeechAt: 0, speechEndAt: 400, vadProcessingMs: 2, chunkDetectedAt: 100, queuedAt: 500, dequeuedAt: 550, requestAt: 560, responseAt: 1000 }
const register = id => { const event = {}; m.attachCaptionTiming(event, { ...timing }); m.registerCaptionTiming(id, event) }
try {
  m.setCaptionMeasurementActive(true); register('normal'); m.reportCaptionPaint(['normal'], 1020)
  assert.equal(samples.find(x => x.stage === 't5_paint').seconds, .02)
  assert.equal(samples.find(x => x.stage === 'e2e_asr').seconds, .62)
  // Fallback（無 Server-Timing）：整段往返 560→1000 全部歸入 t5_network，不產生負值。
  assert.equal(samples.find(x => x.stage === 't5_network').seconds, .44)
  for (const stage of ARRIVAL) assert.equal(count(stage), 1, `${stage} recorded on arrival`)
  const arrival = ARRIVAL.map(count), painted = count('t5_paint')
  register('leave'); m.setCaptionMeasurementActive(false); m.setCaptionMeasurementActive(true); m.reportCaptionPaint(['leave'], 100000)
  assert.equal(count('t5_network'), arrival[3] + 1, 'arrival stages recorded; navigation cannot create a delayed paint')
  assert.equal(count('t5_paint'), painted, 'navigation clears pending paints')
  m.setCaptionMeasurementActive(false); register('away'); m.setCaptionMeasurementActive(true); m.reportCaptionPaint(['away'], 100000)
  assert.equal(count('t5_network'), arrival[3] + 1, 'registration while inactive produces nothing at all')
  register('hidden'); document.visibilityState = 'hidden'; listeners.visibilitychange(); document.visibilityState = 'visible'; listeners.visibilitychange(); m.reportCaptionPaint(['hidden'], 100000)
  assert.equal(count('t5_network'), arrival[3] + 2, 'hidden tabs keep the arrival batch but drop the paint batch')
  assert.equal(count('t5_paint'), painted, 'hidden tabs never replay paints')
  register('offscreen'); m.discardCaptionPaint(['offscreen']); m.reportCaptionPaint(['offscreen'], 100000)
  assert.equal(count('t5_network'), arrival[3] + 3, 'discarded captions still keep their arrival samples')
  assert.equal(count('t5_paint'), painted, 'discarded captions never paint')
  m.registerTranslationTiming('translation', 1000, 1100); m.setCaptionMeasurementActive(false); m.setCaptionMeasurementActive(true); m.reportTranslationPaint(['translation'], 100000)
  assert.equal(count('t7_network'), 0, 'remounts clear translation timings before paint')
  assert.equal(count('t5_paint'), painted, 'only the normal caption painted once')
  // Requests may resolve after returning: clearing pending maps alone is insufficient.
  now = 2000; m.setCaptionMeasurementActive(false); now = 5000; m.setCaptionMeasurementActive(true)
  const arrivals = count('t5_network'), paints = count('t5_paint')
  const crossing = {}; m.attachCaptionTiming(crossing, { ...timing, responseAt: 5100 })
  m.registerCaptionTiming('crossing-navigation', crossing); m.reportCaptionPaint(['crossing-navigation'], 5120)
  now = 6000; document.visibilityState = 'hidden'; listeners.visibilitychange()
  now = 9000; document.visibilityState = 'visible'; listeners.visibilitychange()
  const hiddenRequest = {}; m.attachCaptionTiming(hiddenRequest, { ...timing, chunkSpeechAt: 5500, queuedAt: 5900, responseAt: 9100 })
  m.registerCaptionTiming('crossing-hidden', hiddenRequest); m.reportCaptionPaint(['crossing-hidden'], 9120)
  m.registerTranslationTiming('crossing-translation', 5900, 9100); m.reportTranslationPaint(['crossing-translation'], 9120)
  assert.equal(count('t5_paint'), paints, 'cross-boundary fetch callbacks excluded as well as paints')
  assert.equal(count('t7_network'), 0, 'cross-boundary translation requests are excluded')
  assert.equal(count('t5_network'), arrivals, 'cross-boundary arrivals are excluded')
  const fresh = {}; m.attachCaptionTiming(fresh, { chunkSpeechAt: 9100, chunkDetectedAt: 9200, queuedAt: 9500, dequeuedAt: 9550, requestAt: 9560, responseAt: 10000, speechAt: 9100, speechEndAt: 9400 })
  m.registerCaptionTiming('fresh', fresh); m.reportCaptionPaint(['fresh'], 10020)
  assert.equal(count('t5_paint'), paints + 1, 'in-window captions still paint')
  assert.equal(samples.filter(x => x.stage === 'e2e_asr').at(-1).seconds, .62)
  // 翻譯鏈路：t6/t7 與 Server-Timing 拆分（queue+model+gateway+network 不重疊）。
  m.registerTranslationTiming('fresh', 10200, 10600, { queue: 10, model: 300, total: 320 })
  m.reportTranslationPaint(['fresh'], 10700)
  assert.equal(samples.find(x => x.stage === 't6_wait').seconds, .2, 't6_wait = 原文完成 → 翻譯發出')
  assert.equal(samples.find(x => x.stage === 't6_queue').seconds, .01)
  assert.equal(samples.find(x => x.stage === 't6_model').seconds, .3)
  assert.equal(samples.find(x => x.stage === 't6_gateway').seconds, .01, 't6_gateway = total − queue − model')
  assert.equal(samples.find(x => x.stage === 't7_network').seconds, .08, 't7_network = 往返 − server total')
  assert.equal(samples.find(x => x.stage === 't7_paint').seconds, .1)
  assert.equal(samples.find(x => x.stage === 'e2e_translation').seconds, 1.3, 'e2e = 最後語音樣本 → 譯文繪出')
  assert.equal(samples.find(x => x.stage === 'e2e_translation_tail').seconds, 1.3, 'tail latency starts at final voiced sample')
  assert.equal(samples.filter(x => x.stage === 'phase_t5').at(-1).seconds, .46, 'phase t5 sums network and paint once')
  assert.equal(samples.find(x => x.stage === 'phase_t6').seconds, .52, 'phase t6 sums all four slices into one observation')
  assert.equal(samples.find(x => x.stage === 'phase_t7').seconds, .18, 'phase t7 sums network and paint')
  console.log('PASS navigation, hidden tabs, offscreen captions and translation remounts never replay stale paints; cross-boundary fetch callbacks excluded as well as paints')
} finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete global[key]; else global[key] = value } }
