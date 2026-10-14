const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { createWriteStream } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { finished } = require('node:stream/promises')
const { buildSync } = require('esbuild')

const code = buildSync({ entryPoints: ['src/main/recording/recover-recordings.ts'], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const bundled = { exports: {} }
new Function('module', 'exports', 'require', code)(bundled, bundled.exports, require)
const { recoverRecordings, discardRecoverableRecording } = bundled.exports

const entry = (id, path, state = 'active') => ({ id, path, sampleRate: 16_000, createdAt: `2026-10-14T00:00:0${id.length}Z`, state })
const header = (rate, bytes) => Buffer.from(`rate=${rate};bytes=${bytes}`.padEnd(44, ' '))
const writeStream = async (path, bytes, value) => {
  const stream = createWriteStream(path)
  stream.end(Buffer.alloc(bytes, value))
  await finished(stream)
}
const managed = async entries => {
  let current = [...entries]
  return {
    read: async () => [...current],
    update: async update => { current = update(current) },
    entries: () => current
  }
}

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-native-recovery-'))
  try {
    const activePath = join(directory, 'active.wav.part')
    const stalePath = join(directory, 'stale.wav.part')
    const unavailablePath = join(directory, 'unavailable.wav.part')
    const concurrentPath = join(directory, 'concurrent.wav.part')
    const outsidePath = join(tmpdir(), 's2t-outside.wav.part')
    await Promise.all([
      writeStream(activePath, 96, 7),
      writeStream(stalePath, 100, 8),
      writeStream(concurrentPath, 88, 9),
      writeFile(outsidePath, Buffer.alloc(92, 3))
    ])
    const active = entry('active', activePath)
    const stale = entry('stale', stalePath)
    const unavailable = entry('unavailable', unavailablePath)
    const outside = entry('outside', outsidePath)
    const manifest = await managed([active, stale, unavailable, outside])
    const recovered = []
    let added = false
    const recovery = await recoverRecordings({
      ...manifest,
      isActive: candidate => candidate.id === active.id,
      isAllowedPath: candidate => candidate.startsWith(`${directory}/`),
      header,
      recovered: candidate => recovered.push(candidate.id),
      files: {
        stat: async path => {
          const result = await stat(path)
          if (path === stalePath && !added) {
            added = true
            await manifest.update(entries => [...entries, entry('concurrent', concurrentPath)])
          }
          return result
        }
      }
    })
    assert.deepEqual(recovery.map(item => item.id), ['stale'])
    assert.deepEqual(recovered, ['stale'])
    assert.deepEqual(await readFile(activePath), Buffer.alloc(96, 7), 'an active source is never rewritten')
    assert.deepEqual(await readFile(outsidePath), Buffer.alloc(92, 3), 'a path outside the account recovery root is never touched')
    assert.equal((await readFile(stalePath)).subarray(0, 19).toString(), 'rate=16000;bytes=56', 'recovery writes a WAV header to the completed source')
    assert.deepEqual(manifest.entries().map(item => [item.id, item.state]), [['active', 'active'], ['stale', 'finished'], ['unavailable', 'active'], ['outside', 'active'], ['concurrent', 'active']], 'active, unavailable, unsafe, and concurrent entries remain in the manifest')

    await discardRecoverableRecording(active.id, { ...manifest, isActive: candidate => candidate.id === active.id, isAllowedPath: candidate => candidate.startsWith(`${directory}/`) })
    assert.equal((await stat(activePath)).size, 96, 'discard never removes an active source')
    assert.ok(manifest.entries().some(item => item.id === active.id), 'discard preserves an active manifest entry')

    let failedUpdate = false
    await assert.rejects(() => recoverRecordings({
      read: async () => { throw new Error('temporary manifest read failure') },
      update: async () => { failedUpdate = true },
      isActive: () => false,
      isAllowedPath: () => true,
      header,
      recovered: () => {}
    }), /temporary manifest read failure/)
    assert.equal(failedUpdate, false, 'a manifest read failure cannot issue a clearing update')
    console.log('PASS native recovery preserves active, transient-failure, unsafe, and concurrent manifest evidence')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(join(tmpdir(), 's2t-outside.wav.part'), { force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
