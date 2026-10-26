#!/usr/bin/env node
// Actual production adapter, real PCM, immediate transport: measures segmentation,
// not model quality or wall-clock latency. Exported WAVs can be scored by real ASR.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const out = process.argv[2]
const ffmpeg = process.env.FFMPEG
if (!out || !ffmpeg) throw Error('Usage: FFMPEG=/path/ffmpeg node scripts/evaluation/segmentation-sweep.cjs OUTPUT_DIR')
fs.mkdirSync(out, { recursive: true })
const compiled = buildSync({ entryPoints: ['frontend/src/features/models/adapters/openai-chunked.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new module.constructor('segmentation-eval')
loaded.paths = module.paths
loaded._compile(compiled.outputFiles[0].text, 'segmentation-eval.cjs')
const { OpenAiChunkedModelAdapter } = loaded.exports
global.window = { setTimeout, clearTimeout }
const root = 'music/taiwan-tongues/clips'
const decode = file => {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 20e6 })
  if (result.status !== 0) throw Error(String(result.stderr))
  return new Float32Array(result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.length))
}
async function main() {
  const clips = []
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.json')).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, file)))
    const chars = [...meta.sentence.replace(/[^\p{L}\p{N}]/gu, '')].length
    if (chars < 10) continue
    const source = path.join(root, file.replace('.json', '.mp3'))
    const audio = decode(source)
    // Rate denominator excludes leading/trailing silence only. Internal pauses remain.
    let first = audio.length, last = 0
    for (let i = 0; i < audio.length; i += 160) {
      const frame = audio.subarray(i, i + 160)
      const rms = Math.sqrt(frame.reduce((sum, x) => sum + x*x, 0) / frame.length)
      if (rms > .008) { first = Math.min(first, i); last = i + frame.length }
    }
    if (last <= first) continue
    clips.push({ id: file.slice(0, -5), speaker: createHash('sha256').update(meta.client_id).digest('hex').slice(0, 12), text: meta.sentence, chars, rate: chars / ((last-first)/16000), first, last, audio, source })
  }
  clips.sort((a,b) => a.rate-b.rate)
  const selected = [], speakers = new Set()
  for (const [tier, fraction] of [['slow', .1], ['medium', .5], ['fast', .9]]) {
    const candidates = [...clips].sort((a,b) => Math.abs(clips.indexOf(a)/clips.length-fraction)-Math.abs(clips.indexOf(b)/clips.length-fraction))
    for (const clip of candidates) {
      if (speakers.has(clip.speaker)) continue
      selected.push({ ...clip, tier }); speakers.add(clip.speaker)
      if (selected.filter(c => c.tier === tier).length === 4) break
    }
  }
  if (selected.length !== 12 || speakers.size !== 12) throw Error("Need 12 distinct eligible speakers to compare three speed groups")
  const results = []
  for (const clip of selected) {
    for (const [maximum, silence] of [[3000,250],[3000,400],[3000,600],[4000,400],[6000,400]]) {
      const chunks = [], events = []
      const adapter = new OpenAiChunkedModelAdapter({ id: 'eval', endpoint: '/unused', model: 'segmentation-only', vadConfig: { minSpeechMs:120, minSilenceMs:silence, preRollMs:300, noiseFloorOffsetDb:12, chunkMinMs:700, chunkMaxMs:maximum } }, {
        cancellation:'result', ensureReady:async()=>{}, hasSpeech:async()=>true,
        transcribe: async request => { chunks.push(Buffer.from(request.audio)); return { text:'分段量測' } }
      })
      adapter.onTranscript(event => events.push(event))
      await adapter.start({ sampleRate:16000, language:'zh-TW', targetLanguage:'en' })
      const padded = new Float32Array(clip.audio.length + 16000)
      padded.set(clip.audio)
      for (let offset=0; offset<padded.length; offset+=128) {
        adapter.pushAudio(padded.subarray(offset, offset+128), offset)
        // Drain immediate transport to avoid introducing artificial overload.
        await new Promise(resolve => setImmediate(resolve))
      }
      await adapter.stop()
      const finals = events.filter(e => !e.boundaryOnly)
      const internalEndpoints = finals.filter(e => e.isSentenceBoundary && e.endMs < clip.last/16 - 50).length
      const names = chunks.map((chunk, i) => {
        const name = `${clip.id}-${maximum}-${silence}-${i}.wav`
        fs.writeFileSync(path.join(out, name), chunk)
        return name
      })
      results.push({ id:clip.id, speaker:clip.speaker, tier:clip.tier, text:clip.text, chars:clip.chars, charsPerSecond:clip.rate, durationMs:clip.audio.length/16, silenceMs:silence, maximumMs:maximum, requests:chunks.length, internalEndpoints, chunks:names, events: finals.map(e=>({startMs:e.startMs,endMs:e.endMs,isSentenceBoundary:e.isSentenceBoundary})), voicedEndMs:clip.last/16, sourceSha256:createHash('sha256').update(fs.readFileSync(clip.source)).digest('hex') })
    }
  }
  const report = { source:'https://huggingface.co/datasets/adi-gov-tw/Taiwan-Tongues-ASR-CE-dataset-zhtw', candidates:clips.length, distinctSpeakers:speakers.size, notes:'Natural speakers; no time stretching. Immediate transport only measures boundaries; internal endpoints are proxies, not human sentence annotations.', results }
  fs.writeFileSync(path.join(out, 'segmentation.json'), JSON.stringify(report,null,2))
  for (const [maximum, silence] of [[3000,250],[3000,400],[3000,600],[4000,400],[6000,400]]) {
    const rows = results.filter(r=>r.silenceMs===silence && r.maximumMs===maximum)
    console.log(JSON.stringify({ maximumMs:maximum, silenceMs:silence, clips:rows.length, requests:rows.reduce((n,r)=>n+r.requests,0), internalEndpoints:rows.reduce((n,r)=>n+r.internalEndpoints,0) }))
  }
}
main().catch(error=>{ console.error(error); process.exitCode=1 })
