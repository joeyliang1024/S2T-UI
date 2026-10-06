const { monitorEventLoopDelay } = require('node:perf_hooks')
const stages = new Set(['speech_to_first_paint', 'vad_onset', 'chunk_wait', 'browser_queue', 'browser_preprocess', 'asr_roundtrip_with_retries', 'response_to_paint', 'translation_roundtrip', 'translation_response_to_paint', 'translation_schedule_wait', 'speech_to_translation_paint'])
const buckets = [.025, .05, .1, .15, .25, .4, .6, .8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 8, 12, 20, 30, 60, 120, 300]
const histograms = new Map()
const events = new Map()
const allowedEvents = new Set(['speech_detected', 'asr_empty', 'asr_failed', 'audio_gap', 'telemetry_dropped'])
// Expose zero baselines before the first browser sample, so a first scrape
// does not silently lose the initial observation when Prometheus calculates rate.
for (const stage of stages) {
  const labels = `stage=${JSON.stringify(stage)}`, name = 's2t_caption_stage_duration_seconds'
  histograms.set(`${name}:${labels}`, { name, labels, sum: 0, count: 0, errors: 0, buckets: buckets.map(() => 0) })
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
  for (const sample of body.samples) observe('s2t_caption_stage_duration_seconds', { stage: sample.stage }, sample.seconds)
  return true
}
module.exports = { observe, measure, render, instrumentStorage, acceptCaptionSamples }
