const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ffmpegPath = () => {
  try { return require('ffmpeg-static') } catch { return null }
}
const dynaudnormStatus = () => {
  const path = ffmpegPath()
  return path ? { available: true, path } : { available: false, reason: '缺少 ffmpeg-static，無法使用 dynaudnorm' }
}

// This function is only invoked inside a worker_thread.  Limit both input and
// output so a malformed audio body cannot consume the Pod's memory.
const dynaudnormWav = (audio) => new Promise((resolve, reject) => {
  const status = dynaudnormStatus()
  if (!status.available) { reject(new Error(status.reason)); return }
  const child = spawn(status.path, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-af', 'dynaudnorm=f=150:g=15:p=0.9:m=10', '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []; const errors = []; let size = 0
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('dynaudnorm 處理逾時')) }, 30_000)
  child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 120 * 1024 * 1024) { child.kill('SIGKILL'); return } output.push(chunk) })
  child.stderr.on('data', (chunk) => errors.push(chunk))
  child.on('error', (error) => { clearTimeout(timer); reject(error) })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (size > 120 * 1024 * 1024) return reject(new Error('dynaudnorm 輸出超過上限'))
    if (code !== 0) return reject(new Error(`dynaudnorm 失敗：${Buffer.concat(errors).toString('utf8').slice(0, 500) || `ffmpeg code ${code}`}`))
    resolve(Buffer.concat(output))
  })
  child.stdin.end(audio)
})

// WAV → M4A (AAC inside MP4). The output is staged in a file because ffmpeg
// cannot mux mp4 to a non-seekable pipe, and faststart keeps the hint table at
// the front so browsers can start reading immediately.
const transcodeM4a = async (audio) => {
  const path = ffmpegPath()
  if (!path) throw new Error('缺少 ffmpeg-static，無法轉檔 M4A')
  const inputPath = join(tmpdir(), `s2t-transcode-${randomUUID()}.wav`)
  const outputPath = join(tmpdir(), `s2t-transcode-${randomUUID()}.m4a`)
  await writeFile(inputPath, audio, { mode: 0o600 })
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errorText = ''
      child.stderr.on('data', (chunk) => { if (errorText.length < 4000) errorText += chunk.toString('utf8') })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('M4A 轉檔逾時')) }, 180000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg M4A 轉檔失敗：${errorText.trim().slice(0, 500) || `exit ${code}`}`))
      })
    })
    return await readFile(outputPath)
  } finally {
    await rm(inputPath, { force: true })
    await rm(outputPath, { force: true })
  }
}

module.exports = { dynaudnormStatus, dynaudnormWav, transcodeM4a }
