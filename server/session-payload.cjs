const { gunzip } = require('node:zlib')
const { promisify } = require('node:util')
const unzip = promisify(gunzip)
const MAX_SESSION_BYTES = 32 * 1024 * 1024
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024
const failure = (status, message) => Object.assign(new Error(message), { status })

const readSessionPayload = async request => {
  const encoding = (request.headers['content-encoding'] || 'identity').trim().toLowerCase()
  if (!['gzip', 'identity'].includes(encoding)) throw failure(415, '紀錄同步不支援此壓縮格式')
  const limit = encoding === 'gzip' ? MAX_COMPRESSED_BYTES : MAX_SESSION_BYTES
  if (Number(request.headers['content-length']) > limit) throw failure(413, '紀錄同步資料超過大小上限')
  const encoded = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      request.removeListener('data', data); request.removeListener('end', end)
      request.removeListener('error', broken); request.removeListener('aborted', aborted)
      if (error) { request.pause(); request.once('error', () => undefined); reject(error) } else resolve(value)
    }
    const data = chunk => { size += chunk.length; if (size > limit) finish(failure(413, '紀錄同步資料超過大小上限')); else chunks.push(chunk) }
    const end = () => finish(null, Buffer.concat(chunks))
    const broken = () => finish(failure(400, '紀錄同步傳輸中斷'))
    const aborted = broken
    request.on('data', data); request.once('end', end); request.once('error', broken); request.once('aborted', aborted)
  })
  let decoded = encoded
  if (encoding === 'gzip') {
    try { decoded = await unzip(encoded, { maxOutputLength: MAX_SESSION_BYTES }) }
    catch (error) { throw failure(error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, error.code === 'ERR_BUFFER_TOO_LARGE' ? '紀錄解壓縮後超過大小上限' : '紀錄壓縮資料無效') }
  }
  try { return JSON.parse(decoded.toString('utf8')) } catch { throw failure(400, '紀錄 JSON 格式無效') }
}

// Paused IncomingMessages apply socket backpressure while admission is queued.
// Bound complete save operations, including parsing and database serialization.
const createSessionWriteGate = (maximum = 2, maxWaiting = 32, waitMs = 10000) => {
  let active = 0
  const waiting = []
  const release = () => {
    active--
    const next = waiting.shift()
    if (next) { clearTimeout(next.timer); active++; next.resolve() }
  }
  return async operation => {
    if (active < maximum) active++
    else {
      if (waiting.length >= maxWaiting) throw failure(503, '紀錄同步忙碌，請稍後重試')
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: null }
        entry.timer = setTimeout(() => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(failure(503, '紀錄同步等待逾時，請稍後重試')) }, waitMs)
        waiting.push(entry)
      })
    }
    try { return await operation() } finally { release() }
  }
}
module.exports = { readSessionPayload, createSessionWriteGate, MAX_SESSION_BYTES, MAX_COMPRESSED_BYTES }
