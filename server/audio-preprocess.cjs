const { spawn } = require('node:child_process')

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

module.exports = { dynaudnormStatus, dynaudnormWav }
