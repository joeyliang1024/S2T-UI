// Verify audio residency: the second heavy job of one request must not clone
// the recording across the thread boundary again.
const { readFileSync } = require('node:fs')
const { diarizeWav, extractDiarizedSpeakerBlocks, audioWorkerPool } = require('../../server/audio-worker-pool.cjs')

const wav = readFileSync(process.env.S2T_TEST_AUDIO_FILE || require('node:path').join(__dirname, '../fixtures/speech-sample.wav'))

;(async () => {
  const segments = await diarizeWav(wav)
  await extractDiarizedSpeakerBlocks(wav, segments)
  const ops = audioWorkerPool.stats().ops
  for (const [name, value] of Object.entries(ops)) {
    console.log(`${name}: audioBytes=${value.audioBytes} transferredBytes=${value.transferredBytes} saved=${value.audioBytes - value.transferredBytes} count=${value.count} rtf=${value.rtf}`)
  }
  const diarize = ops.diarizeWav
  const blocks = ops.extractSpeakerBlocks
  if (!diarize || !blocks) throw new Error('missing op stats')
  if (blocks.transferredBytes !== 0) throw new Error(`expected the retained audio to avoid a second clone, got ${blocks.transferredBytes} bytes`)
  if (diarize.transferredBytes !== diarize.audioBytes) throw new Error('the first job must transfer the audio once')
  console.log('audio residency smoke test passed.')
  await audioWorkerPool.close()
})().catch(async (error) => {
  console.error(error)
  await audioWorkerPool.close().catch(() => undefined)
  process.exitCode = 1
})
