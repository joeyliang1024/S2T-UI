const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const samples = [], listeners = {}
const saved = { document: global.document, window: global.window, metricSamples: global.metricSamples, performance: global.performance }
global.document = { visibilityState: 'visible', addEventListener: (name, handler) => { listeners[name] = handler } }
global.performance = { now: () => -1 }
global.window = {}; global.metricSamples = samples
const source = fs.readFileSync('src/renderer/src/shared/services/caption-metrics.ts', 'utf8')
  .replace(/import .* from '\.\/caption-metric-transport'/, 'class CaptionMetricTransport { constructor(sender: unknown) {} enqueue(samples: unknown[]) { globalThis.metricSamples.push(...samples) } } type CaptionMetricSample = {stage: string; seconds: number}')
  .replace(/import .* from .*(?:auth-client|authenticated-client)'/, 'const authFetch = async () => ({ok: true})')
const code = buildSync({ stdin: { contents: source, loader: 'ts' }, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const mod = { exports: {} }; new Function('module', 'exports', code)(mod, mod.exports)
const m = mod.exports
const at = stage => samples.find(x => x.stage === stage)
try {
  // Server-Timing 解析：毫秒、無效值與缺少 total 的處理。
  assert.deepEqual(m.parseServerTiming('upload;dur=12.5, queue;dur=0.30, pre;dur=0.00, model;dur=820.00, total;dur=840.00'), { total: 840, upload: 12.5, queue: .3, pre: 0, model: 820 })
  assert.deepEqual(m.parseServerTiming('upload;dur=oops, total;dur=840'), { total: 840 }, 'malformed entries are dropped, not fatal')
  assert.equal(m.parseServerTiming(null), undefined)
  assert.equal(m.parseServerTiming('upload;dur=12'), undefined, 'without total there is no trustworthy split')

  m.setCaptionMeasurementActive(true)
  // 一條真實鏈路：VAD 120ms、分段 380ms、佇列 60ms、Silero 80ms、編碼 60ms、
  // 伺服器 upload/queue/model=40/5/3000ms、後處理 10ms、網路與重試 900ms、繪出 20ms。
  const timing = {
    chunkSpeechAt: 0, speechEndAt: 400, vadProcessingMs: 2, chunkDetectedAt: 120, queuedAt: 500, dequeuedAt: 560,
    sileroStartAt: 560, sileroEndAt: 640, sileroProcessingMs: 30, requestAt: 700, responseAt: 4700, postEndAt: 4710,
    server: { upload: 40, queue: 5, pre: 0, model: 3000, total: 3100 }
  }
  const event = {}
  m.attachCaptionTiming(event, timing)
  m.registerCaptionTiming('slice-math', event)
  m.reportCaptionPaint(['slice-math'], 4730)
  assert.equal(at('t2_vad').seconds, .002)
  assert.equal(at('t2_segment'), undefined)
  assert.equal(at('t2_gate').seconds, .03)
  assert.equal(at('t1_queue').seconds, .06)
  assert.equal(at('t1_encode').seconds, .06, 't1_encode excludes the Silero gate window')
  assert.equal(at('t1_upload').seconds, .04)
  assert.equal(at('t3_queue').seconds, .005)
  assert.equal(at('t3_model').seconds, 3)
  assert.equal(at('t3_gateway').seconds, .055, 'gateway = total − upload − queue − pre − model')
  assert.equal(at('t4_postprocess').seconds, .01)
  assert.equal(at('t5_network').seconds, .9, 'network = roundtrip − server total, retries included')
  assert.equal(at('t5_paint').seconds, .02)
  assert.equal(at('e2e_asr').seconds, 4.33)
  assert.equal(at('t3_preprocess'), undefined, 'disabled preprocessing must not emit a zero sample')
  assert.equal(at('phase_t2').seconds, .032, 'VAD CPU and gate only; audio accumulation is excluded')

  // 異常拆分不得輸出負值或超界值（樣本上限 300 秒）。
  const broken = { chunkSpeechAt: 100, chunkDetectedAt: 200, queuedAt: 300, dequeuedAt: 320, requestAt: 340, responseAt: 1000, postEndAt: 1010, server: { upload: 10, queue: 0, model: 400000, total: 5000 } }
  const brokenEvent = {}
  m.attachCaptionTiming(brokenEvent, broken)
  m.registerCaptionTiming('broken', brokenEvent)
  assert.equal(samples.filter(x => x.stage === 't3_model').length, 1, 'out-of-range server model time is dropped, never clamped')
  assert.equal(samples.filter(x => x.stage === 't5_network').length, 1, 'server total beyond the roundtrip yields no negative network sample')
  assert.ok(samples.every(x => Number.isFinite(x.seconds) && x.seconds >= 0 && x.seconds <= 300))
  console.log('PASS Server-Timing parsing, non-overlapping t1~t7 slice math and out-of-range guards')
} finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete global[key]; else global[key] = value } }
