// The stabilizer only pays for per-label voiceprints when it asked for them
// (VOICEPRINT_ACCURACY §12.8): the sliding-window preview sets
// x-s2t-speaker-embeddings, the full-track passes do not, because they would
// spend the same RTF across the whole recording for a signal nobody reads.
// This boots a real gateway and asserts that contract on the wire.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const silentWav = () => {
  const audio = Buffer.alloc(44 + 16_000 * 2)
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
  audio.write('data', 36); audio.writeUInt32LE(32_000, 40)
  return audio
}

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-preview-embeddings-'))
  const port = 21000 + Math.floor(Math.random() * 1000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.cjs'], {
    cwd: join(__dirname, '..', '..'),
    // Isolated local storage, same reason as gateway-auth-smoke: a developer's
    // remote-storage .env must not decide what this test talks to.
    env: { ...process.env, S2T_WEB_PORT: String(port), S2T_LOCAL_DATA_DIR: directory, S2T_WEB_ORIGINS: 'http://127.0.0.1:5173', S2T_BOOTSTRAP_ADMIN_USERNAME: '', S2T_BOOTSTRAP_ADMIN_PASSWORD: '', S2T_ASR_ENDPOINT: 'http://127.0.0.1:9/v1', S2T_ASR_MODEL: 'smoke-asr', S2T_ASR_API_KEY: 'smoke-key', S2T_MINIO_ENDPOINT: '', S2T_MINIO_BUCKET: '', S2T_MINIO_ACCESS_KEY: '', S2T_MINIO_SECRET_KEY: '', S2T_POSTGRES_HOST: '', S2T_POSTGRES_PORT: '', S2T_POSTGRES_DB_NAME: '', S2T_POSTGRES_USER: '', S2T_POSTGRES_PASSWORD: '', S2T_MILVUS_ENDPOINT: '', S2T_MILVUS_DB_NAME: '', S2T_MILVUS_COLLECTION: '', S2T_MILVUS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (value) => { output += value })
  child.stderr.on('data', (value) => { output += value })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway did not start: ${output}`)), 15_000)
      child.stdout.on('data', () => {
        if (output.includes('gateway.started')) { clearTimeout(timer); resolve() }
      })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited (${code}): ${output}`)) })
    })

    const registered = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'preview', password: 'smoke-password', NT: 'Preview', Department: 'Engineering' }) })
    assert.equal(registered.status, 201)
    const token = (await registered.json()).token
    const bearer = { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' }

    // Default contract: no field, so a full-track pass stays free of it.
    const plain = await fetch(`${base}/api/diarizations`, { method: 'POST', headers: bearer, body: silentWav() })
    assert.equal(plain.status, 200, `plain diarization must succeed: ${await plain.clone().text()}`)
    const plainBody = await plain.json()
    assert.equal('speaker_embeddings' in plainBody, false, 'a request that did not ask for voiceprints must not carry them')

    // The preview asks, and the gateway answers with the per-label map —
    // empty here because the clip has no speech, which is still a map.
    const preview = await fetch(`${base}/api/diarizations`, { method: 'POST', headers: { ...bearer, 'x-s2t-speaker-embeddings': '1' }, body: silentWav() })
    assert.equal(preview.status, 200, `preview diarization must succeed: ${await preview.clone().text()}`)
    const previewBody = await preview.json()
    assert.equal(typeof previewBody.speaker_embeddings, 'object', 'the preview response must carry a per-label voiceprint map')
    assert.notEqual(previewBody.speaker_embeddings, null)
    assert.deepEqual(previewBody.speaker_embeddings, {}, 'a clip with no speech yields no labels to embed')
    assert.ok(Array.isArray(previewBody.exclusive_diarization), 'diarization segments are unaffected by the flag')

    // Anything but the exact flag leaves the cost off, so a stray header value
    // cannot silently turn the extra pass on.
    const stray = await fetch(`${base}/api/diarizations`, { method: 'POST', headers: { ...bearer, 'x-s2t-speaker-embeddings': 'yes' }, body: silentWav() })
    assert.equal(stray.status, 200)
    const strayBody = await stray.json()
    assert.equal('speaker_embeddings' in strayBody, false, 'only the exact preview flag opts into the extra embedding pass')

    console.log('Diarization preview embeddings smoke test passed.')
  } finally {
    child.kill()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
