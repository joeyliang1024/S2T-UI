const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createReadStream } = require('node:fs')
const { mkdtemp, readFile, rm, readdir, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { convertImportAudio } = require('../../server/import-audio.cjs')
const binary = require('ffmpeg-static')
const generate = (file, codec, format, extra = []) => {
  const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-ac', '2', '-c:a', codec, ...extra, ...(format ? ['-f', format] : []), file], { timeout: 30000 })
  assert.equal(result.status, 0, result.stderr?.toString())
}
const checkWav = async file => {
  const b = await readFile(file)
  assert.equal(b.toString('ascii', 0, 4), 'RIFF')
  let offset = 12, dataBytes = 0
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4), n = b.readUInt32LE(offset + 4)
    if (id === 'fmt ') { assert.equal(b.readUInt16LE(offset + 8), 1); assert.equal(b.readUInt16LE(offset + 10), 1); assert.equal(b.readUInt32LE(offset + 12), 16000); assert.equal(b.readUInt16LE(offset + 22), 16) }
    if (id === 'data') dataBytes = n
    offset += 8 + n + n % 2
  }
  assert.ok(dataBytes > 60000 && dataBytes < 75000)
}
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-import-test-'))
  const before = (await readdir(tmpdir())).filter(x => x.startsWith('s2t-import-'))
  const formats = { wav: ['pcm_f32le'], mp3: ['libmp3lame'], m4a: ['aac'], aac: ['aac'], ogg: ['libvorbis'], webm: ['libopus'], flac: ['flac'], mp4: ['aac'], mov: ['aac'], mpeg: ['mp2', 'mpeg'], mpg: ['mp2', 'mpeg'], mpga: ['mp2', 'mp2'], opus: ['libopus'], mkv: ['flac'], avi: ['pcm_s16le'], aiff: ['pcm_s16be'], aif: ['pcm_s16be', 'aiff'], wma: ['wmav2'] }
  const passed = []
  try {
    for (const [extension, [codec, format]] of Object.entries(formats)) {
      const file = join(directory, 'tone.' + extension)
      generate(file, codec, format)
      const result = await convertImportAudio(createReadStream(file))
      try { await checkWav(result.path); passed.push(extension) } finally { await result.dispose() }
    }
    await assert.rejects(convertImportAudio(createReadStream(join(directory, 'tone.mp3')), { maximum: 50000 }), error => error.status === 413)
    await assert.rejects(convertImportAudio(Readable.from([Buffer.from('broken')])), error => error.status === 422)
    await assert.rejects(convertImportAudio(Readable.from([])), error => error.status === 400)
    await assert.rejects(convertImportAudio(Readable.from([Buffer.alloc(128)]), { maximum: 64 }), error => error.status === 413)
    const video = join(directory, 'no-audio.mp4')
    const generated = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=32x32:d=1', '-c:v', 'mpeg4', video])
    assert.equal(generated.status, 0)
    await assert.rejects(convertImportAudio(createReadStream(video)), error => error.status === 422)
    await assert.rejects(convertImportAudio(Readable.from([Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile:///private/tmp/other-user.wav\n#EXT-X-ENDLIST\n')])), error => error.status === 422)
    const controller = new AbortController()
    const slow = new Readable({ read() {} })
    const pending = convertImportAudio(slow, { signal: controller.signal })
    await assert.rejects(convertImportAudio(Readable.from([Buffer.alloc(1)])), error => error.status === 429)
    controller.abort()
    await assert.rejects(pending, error => error.name === 'AbortError')
    const after = (await readdir(tmpdir())).filter(x => x.startsWith('s2t-import-'))
    assert.deepEqual(after.sort(), before.sort(), 'temporary conversion files must be cleaned')
    console.log(JSON.stringify({ passed: true, formats: passed, pcm16Mono16k: true, invalidEmptyNoAudioRejected: true, inputLimitEnforced: true, outputLimitEnforced: true, playlistsRejected: true, concurrentRejected: true, cancelCleansTemporaryFiles: true }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
