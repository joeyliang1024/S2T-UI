// Verify audio residency: the second heavy job of one request must not clone
// the recording across the thread boundary again.
const { readFileSync } = require('node:fs')
const { diarizeWav, extractDiarizedSpeakerBlocks, sherpaWorkerPool } = require('/Users/liangzhiquan/Desktop/S2T-UI/server/sherpa-worker-pool.cjs')

const wav = readFileSync('/private/var/folders/lw/pnx1tff95cgc3tp0lx78rg9c0000gn/T/opencode/ab.wav')

;(async () => {
  const segments = await diarizeWav(wav)
  await extractDiarizedSpeakerBlocks(wav, segments)
  const ops = sherpaWorkerPool.stats().ops
  for (const [name, value] of Object.entries(ops)) {
    console.log(`${name}: audioBytes=${value.audioBytes} transferredBytes=${value.transferredBytes} saved=${value.audioBytes - value.transferredBytes} count=${value.count} rtf=${value.rtf}`)
  }
  const diarize = ops.diarizeWav
  const blocks = ops.extractSpeakerBlocks
  if (!diarize || !blocks) throw new Error('missing op stats')
  if (blocks.transferredBytes !== 0) throw new Error(`expected the retained audio to avoid a second clone, got ${blocks.transferredBytes} bytes`)
  if (diarize.transferredBytes !== diarize.audioBytes) throw new Error('the first job must transfer the audio once')
  console.log('audio residency smoke test passed.')
  await sherpaWorkerPool.close()
})().catch(async (error) => {
  console.error(error)
  await sherpaWorkerPool.close().catch(() => undefined)
  process.exitCode = 1
})
