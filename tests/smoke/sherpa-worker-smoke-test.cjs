const assert = require('node:assert/strict')
const { assessVoiceprintSample, sherpaWorkerPool, sileroVadStatus } = require('../../server/sherpa-worker-pool.cjs')

const makeWav = ({ seconds = 3.2, sampleRate = 16_000 } = {}) => {
  const frames = Math.floor(seconds * sampleRate)
  const output = Buffer.alloc(44 + frames * 2)
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34)
  output.write('data', 36); output.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index += 1) output.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 220) * 8_000), 44 + index * 2)
  return output
}

;(async () => {
  const quality = await assessVoiceprintSample(makeWav())
  assert.ok(quality.durationMs >= 3_000)
  assert.ok(quality.rmsDbfs > -45)
  // VAD must land on its own pool, not behind voiceprint work on interactive.
  const vad = await sileroVadStatus()
  assert.equal(typeof vad.available, 'boolean')
  const stats = sherpaWorkerPool.stats()
  assert.ok(stats.pools.silero, 'silero pool is reported')
  assert.equal(stats.pools.silero.configured, Number(process.env.S2T_SILERO_VAD_WORKERS || 1))
  assert.equal(stats.pools.silero.ops.sileroStatus?.count, 1, 'sileroVadStatus ran on the silero pool')
  await sherpaWorkerPool.close()
  console.log('sherpa worker smoke test passed')
})().catch(async (error) => {
  await sherpaWorkerPool.close().catch(() => undefined)
  console.error(error)
  process.exitCode = 1
})
