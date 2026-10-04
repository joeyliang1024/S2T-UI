// Official native CPU runtime. One full recording retains one native stream;
// separate preview requests are still independent windows, not a live session.
const { mkdtempSync, writeFileSync, readFileSync, rmSync, accessSync, constants } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { nemotronPaths } = require('./local-diarization.cjs')
const { readWavSamples, resampleMono } = require('./sherpa-diarization.cjs')
const { logger } = require('./logger.cjs')
const SHA256 = '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1'
let verifiedPath
const verifyRuntime = () => {
  const paths = nemotronPaths()
  try { accessSync(paths.runtime, constants.X_OK) } catch { throw new Error(`找不到可執行的 Nemotron CPU runtime（${process.platform}-${process.arch}）：${paths.runtime}`) }
  if (verifiedPath !== paths.model) {
    let model
    try { model = readFileSync(paths.model) } catch { throw new Error(`找不到 Nemotron 模型權重：${paths.model}`) }
    if (createHash('sha256').update(model).digest('hex') !== SHA256) throw new Error('Nemotron 模型 SHA256 不符，請重新安裝本輪驗證的 Q8_0 權重')
    execFileSync(paths.runtime, ['--version'], { timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })
    verifiedPath = paths.model
  }
  return paths
}
const parseRttm = (text, duration) => text.split(/\r?\n/).filter(line => line.trim()).map(line => {
  const fields = line.trim().split(/\s+/)
  const start = Number(fields[3]); const length = Number(fields[4])
  if (fields[0] !== 'SPEAKER' || !/^speaker_[1-8]$/.test(fields[7] || '') || !Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length <= 0 || start >= duration + .001) throw new Error('Nemotron RTTM 格式無效')
  return { start, end: Math.min(duration, start + length), speaker: `SPEAKER_${fields[7].slice(8).padStart(2, '0')}` }
}).sort((a, b) => a.start - b.start || a.end - b.end)
const pcmWav = samples => {
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), 44 + 2 * i)
  return wav
}
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
const diarizeWav = audio => {
  const wave = readWavSamples(audio)
  if (!wave.samples.length) return []
  const samples = resampleMono(wave.samples, wave.sampleRate, 16000)
  const duration = samples.length / 16000
  const paths = verifyRuntime()
  const directory = mkdtempSync(join(tmpdir(), 's2t-nemotron-'))
  try {
    const input = join(directory, 'recording.wav'); const output = join(directory, 'turns.rttm')
    writeFileSync(input, pcmWav(samples))
    // Same heavy-pool timeout knobs; expire the child before the pool kills its worker.
    const budget = Math.min(positive(process.env.S2T_SHERPA_JOB_TIMEOUT_MS, 1800000),
      positive(process.env.S2T_SHERPA_JOB_TIMEOUT_BASE_MS, 60000) + positive(process.env.S2T_SHERPA_JOB_TIMEOUT_PER_AUDIO_SEC, 400) * duration)
    // Full-file v3-offline is still the streaming state machine, not --offline.
    execFileSync(paths.runtime, ['diarize', input, '--model', paths.model, '--backend', 'cpu',
      // CLI presets replace overrides in v0.2.0. Specify ALL geometry explicitly.
      '--diar.chunk', '264', '--diar.right_context', '1', '--diar.left_context', '1',
      '--diar.fifo', '0', '--diar.spkcache', '528', '--diar.update_period', '188', '--format', 'rttm', '--recording-id', 'recording', '--output', output],
    { timeout: Math.max(1, Math.floor(budget) - 2000), maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      // Native geometry must not be overridden by unrelated NVIDIA env settings.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NEMO_SPEECH_'))) })
    return parseRttm(readFileSync(output, 'utf8'), duration)
  } catch (error) {
    logger.error('nemotron.inference.failed', { durationSec: duration, code: error.code || null, exitStatus: error.status ?? null, signal: error.signal || null, phase: error.message === 'Nemotron RTTM 格式無效' ? 'parse' : error.path === join(directory, 'turns.rttm') ? 'output' : 'runtime' })
    if (error.code === 'ETIMEDOUT') throw new Error('Nemotron CPU 推論逾時')
    // Do not expose command, temporary filenames, or raw native diagnostics to API clients.
    throw new Error(error.message === 'Nemotron RTTM 格式無效' ? error.message : 'Nemotron CPU 推論失敗；請確認 runtime 與權重版本')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
module.exports = { diarizeWav, verifyRuntime, parseRttm, pcmWav }
