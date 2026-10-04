const { spawn } = require('node:child_process')
const { createWriteStream } = require('node:fs')
const { mkdtemp, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
let busy = false
const convertImportAudio = async (input, { signal, maximum = MAX_IMPORT_BYTES, binary = require('ffmpeg-static') } = {}) => {
  if (busy) throw Object.assign(new Error('另一個匯入檔案正在轉換，請稍後再試。'), { status: 429 })
  if (!binary) throw new Error('缺少本機 FFmpeg，無法轉換匯入檔案。')
  busy = true
  let directory
  try {
    directory = await mkdtemp(join(tmpdir(), 's2t-import-'))
    const source = join(directory, 'source.media'), output = join(directory, 'converted.wav')
    let bytes = 0
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length
      callback(bytes > maximum ? Object.assign(new Error('匯入檔案超過大小限制。'), { status: 413 }) : null, chunk)
    } })
    await pipeline(input, limiter, createWriteStream(source, { mode: 0o600 }), { signal })
    if (!bytes) throw Object.assign(new Error('匯入檔案不可為空。'), { status: 400 })
    await new Promise((resolve, reject) => {
      // Only local file/pipe protocols: uploaded playlists cannot fetch external files.
      const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'aac,aiff,asf,avi,flac,matroska,webm,mov,mp3,mpeg,mpegts,ogg,wav', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fs', String(maximum), output], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errorText = '', timedOut = false
      const abort = () => child.kill('SIGKILL')
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { timedOut = true; abort() }, 600000)
      child.stderr.on('data', chunk => { if (errorText.length < 2000) errorText += chunk.toString() })
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      child.on('error', error => { cleanup(); reject(error) })
      child.on('close', async code => {
        cleanup()
        const outputSize = await stat(output).then(info => info.size, () => 0)
        if (signal?.aborted) reject(Object.assign(new Error('已取消匯入轉換。'), { name: 'AbortError' }))
        else if (timedOut) reject(new Error('匯入轉換逾時。'))
        else if (outputSize >= maximum) reject(Object.assign(new Error('轉換後 WAV 超過大小限制，請縮短音檔。'), { status: 413 }))
        else if (code !== 0) reject(Object.assign(new Error(`無法讀取音軌或格式不受支援：${errorText.trim().slice(0, 500)}`), { status: 422 }))
        else resolve()
      })
      if (signal?.aborted) abort()
    })
    const size = (await stat(output)).size
    if (size >= maximum) throw Object.assign(new Error('轉換後 WAV 超過大小限制，請縮短音檔。'), { status: 413 })
    if (size < 44) throw Object.assign(new Error('檔案沒有有效音訊。'), { status: 422 })
    const cleanupDirectory = directory
    return { path: output, size, dispose: () => rm(cleanupDirectory, { recursive: true, force: true }) }
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  } finally { busy = false }
}
module.exports = { convertImportAudio, MAX_IMPORT_BYTES }
