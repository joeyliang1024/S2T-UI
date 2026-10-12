const { monitorEventLoopDelay } = require('node:perf_hooks')
// t1~t7 latency pipeline. Slices come from the browser clock plus the
// gateway's Server-Timing header; e2e_* carries the end-to-end observation.
// phase groups the slices so one PromQL can show where time is spent:
//   t1 音訊擷取與上傳 · t2 VAD 偵測與分段 · t3 ASR 模型推論 · t4 文字後處理
//   t5 回傳轉錄與呈現 · t6 翻譯模型 · t7 翻譯回傳與呈現
const captionStageMetric = 's2t_caption_stage_duration_seconds'
const captionStages = ['e2e_asr', 'e2e_translation', 't1_queue', 't1_encode', 't1_upload', 't2_vad', 't2_segment', 't2_gate', 't3_queue', 't3_preprocess', 't3_model', 't3_gateway', 't4_postprocess', 't5_network', 't5_paint', 't6_wait', 't6_queue', 't6_model', 't6_gateway', 't7_network', 't7_paint']
const phaseOf = stage => stage.startsWith('t') ? stage.slice(0, 2) : 'e2e'
const stages = new Set(captionStages)
const buckets = [.025, .05, .1, .15, .25, .4, .6, .8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 8, 12, 20, 30, 60, 120, 300]
const histograms = new Map()
const events = new Map()
const allowedEvents = new Set(['speech_detected', 'asr_empty', 'asr_failed', 'audio_gap', 'telemetry_dropped', 'silero_veto', 'silero_failed'])
// Expose zero baselines before the first browser sample, so a first scrape
// does not silently lose the initial observation when Prometheus calculates rate.
// Label order must match observe() below or a sample would create a second series.
for (const stage of stages) {
  const labels = `stage=${JSON.stringify(stage)},phase=${JSON.stringify(phaseOf(stage))}`
  histograms.set(`${captionStageMetric}:${labels}`, { name: captionStageMetric, labels, sum: 0, count: 0, errors: 0, buckets: buckets.map(() => 0) })
}
for (const event of allowedEvents) events.set(event, 0)
const observe = (name, labels, seconds, failed = false) => {
  if (!Number.isFinite(seconds) || seconds < 0) return
  const labelText = Object.entries(labels).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join(',')
  const key = `${name}:${labelText}`
  let value = histograms.get(key)
  if (!value) { value = { name, labels: labelText, sum: 0, count: 0, errors: 0, buckets: buckets.map(() => 0) }; histograms.set(key, value) }
  value.sum += seconds; value.count++; if (failed) value.errors++
  buckets.forEach((upper, index) => { if (seconds <= upper) value.buckets[index]++ })
}
const measure = async (stage, operation) => {
  const start = performance.now(); let failed = false
  try { return await operation() } catch (error) { failed = true; throw error }
  finally { observe('s2t_server_stage_duration_seconds', { stage }, (performance.now() - start) / 1000, failed) }
}
const instrumentStorage = storage => {
  for (const component of ['blob', 'config', 'vector']) {
    const store = storage[component]
    if (!store) continue
    const prototype = Object.getPrototypeOf(store)
    for (const method of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
      if (method === 'constructor' || method.startsWith('_') || descriptor?.value?.constructor.name !== 'AsyncFunction') continue
      const original = store[method].bind(store)
      // Store operations are asynchronous; preserve their errors and receivers.
      store[method] = async (...args) => {
        const start = performance.now(); let failed = false
        try { return await original(...args) } catch (error) { failed = true; throw error }
        finally { observe('s2t_storage_operation_duration_seconds', { service: storage.mode[component], operation: method }, (performance.now() - start) / 1000, failed) }
      }
    }
  }
}
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable()
const render = () => {
  const lines = []
  const types = new Set()
  for (const metric of histograms.values()) {
    if (!types.has(metric.name)) { lines.push(`# TYPE ${metric.name} histogram`); types.add(metric.name) }
    buckets.forEach((upper, index) => lines.push(`${metric.name}_bucket{${metric.labels},le="${upper}"} ${metric.buckets[index]}`))
    lines.push(`${metric.name}_bucket{${metric.labels},le="+Inf"} ${metric.count}`, `${metric.name}_sum{${metric.labels}} ${metric.sum}`, `${metric.name}_count{${metric.labels}} ${metric.count}`, `${metric.name}_errors_total{${metric.labels}} ${metric.errors}`)
  }
  lines.push('# TYPE s2t_caption_events_total counter')
  for (const [event, count] of events) lines.push(`s2t_caption_events_total{event="${event}"} ${count}`)
  const memory = process.memoryUsage(), cpu = process.cpuUsage()
  lines.push('# TYPE s2t_process_resident_memory_bytes gauge', `s2t_process_resident_memory_bytes ${memory.rss}`, '# TYPE s2t_process_cpu_seconds_total counter', `s2t_process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`, '# TYPE s2t_process_heap_used_bytes gauge', `s2t_process_heap_used_bytes ${memory.heapUsed}`, '# TYPE s2t_process_uptime_seconds gauge', `s2t_process_uptime_seconds ${process.uptime()}`, '# TYPE s2t_event_loop_p99_seconds gauge', `s2t_event_loop_p99_seconds ${loop.percentile(99) / 1e9}`)
  loop.reset()
  return lines.join('\n') + '\n'
}
const acceptCaptionSamples = body => {
  if (!Array.isArray(body?.samples) || body.samples.length > 128) return false
  const eventEntries = Object.entries(body.events || {})
  if (!body.samples.length && !eventEntries.length) return false
  if (eventEntries.some(([name, count]) => !allowedEvents.has(name) || !Number.isSafeInteger(count) || count < 1 || count > 1000)) return false
  if (!body.samples.every(sample => stages.has(sample?.stage) && Number.isFinite(sample.seconds) && sample.seconds >= 0 && sample.seconds <= 300)) return false
  for (const [name, count] of eventEntries) events.set(name, (events.get(name) || 0) + count)
  for (const sample of body.samples) observe(captionStageMetric, { stage: sample.stage, phase: phaseOf(sample.stage) }, sample.seconds)
  return true
}
module.exports = { observe, measure, render, instrumentStorage, acceptCaptionSamples }
