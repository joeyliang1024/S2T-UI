const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { localModelName } = require('../../server/local-diarization.cjs')
const { parseRttm, pcmWav, verifyRuntime } = require('../../server/nemotron-diarization.cjs')
const { readWavSamples } = require('../../server/sherpa-diarization.cjs')
const { parseSpeakerTurns, parseSpeakerEmbeddings } = (() => {
  const { buildSync } = require('esbuild')
  const result = buildSync({ entryPoints: ['src/renderer/src/features/speakers/diarization.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
  const m = new module.constructor('nemotron-renderer-test'); m.paths = module.paths; m._compile(result.outputFiles[0].text, 'nemotron-renderer-test.cjs'); return m.exports
})()
async function main () {
  assert.equal(localModelName({}), 'sherpa-onnx-speaker-diarization')
  assert.equal(localModelName({ S2T_DIARIZATION_MODEL: 'nemotron-3-diarization' }), 'nemotron-3-diarization')
  assert.throws(() => localModelName({ S2T_DIARIZATION_MODEL: 'unknown' }), /不支援/)
  assert.deepEqual(parseRttm('', 10), [])
  assert.equal(parseRttm('SPEAKER test 1 1 2 <NA> <NA> speaker_1 <NA> <NA>', 10)[0].speaker, 'SPEAKER_01')
  assert.throws(() => parseRttm('SPEAKER test 1 -1 2 <NA> <NA> speaker_1', 10), /格式/)
  assert.throws(() => parseRttm('SPEAKER test 1 1 NaN <NA> <NA> speaker_1', 10), /格式/)
  verifyRuntime()
  const pool = require('../../server/sherpa-worker-pool.cjs')
  const original = process.env.S2T_DIARIZATION_MODEL
  try {
    process.env.S2T_DIARIZATION_MODEL = 'nemotron-3-diarization'
    const fixture = process.argv[2] || join(__dirname, '../../tmp/voxconverse/wav/audio/jcako.wav')
    const wave = readWavSamples(readFileSync(fixture))
    const audio = pcmWav(wave.samples.subarray(0, 60 * wave.sampleRate))
    const begin = Date.now(); const turns = await pool.diarizeWav(audio)
    assert.ok(turns.length > 0, 'real speech must yield nonempty turns')
    assert.ok(turns.every(t => /^SPEAKER_\d+$/.test(t.speaker) && t.start >= 0 && t.end <= 60 && t.end > t.start))
    assert.ok(new Set(turns.map(t => t.speaker)).size <= 8)
    assert.equal(parseSpeakerTurns({ exclusive_diarization: turns }).length, turns.length)
    const embeddings = await pool.extractSpeakerLabelEmbeddings(audio, turns)
    assert.ok(Object.keys(embeddings).length > 0)
    assert.ok(Object.keys(parseSpeakerEmbeddings({ speaker_embeddings: embeddings })).length > 0)
    process.env.S2T_DIARIZATION_MODEL = ''
    assert.deepEqual(await pool.diarizeWav(pcmWav(new Float32Array(16000))), [], 'existing sherpa fallback handles silence')
    console.log(JSON.stringify({ passed: true, model: 'nemotron-3-diarization', runtime: 'cpu', seconds: 60, elapsedMs: Date.now() - begin, turns: turns.length, speakers: [...new Set(turns.map(t => t.speaker))], embeddings: Object.keys(embeddings) }))
  } finally {
    if (original === undefined) delete process.env.S2T_DIARIZATION_MODEL; else process.env.S2T_DIARIZATION_MODEL = original
    await pool.sherpaWorkerPool.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
