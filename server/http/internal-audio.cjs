const { timingSafeEqual } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { createReadStream } = require('node:fs')
const { convertImportAudio } = require('../import-audio.cjs')
const { allowed } = require('../audio/operations.cjs')
const { encode, decode } = require('../audio/codec.cjs')
const { createLocalAudioOperations } = require('../audio/clients/local.cjs')
const tokenMatches = (actual, expected) => { const a = Buffer.from(actual || ''), b = Buffer.from(expected || ''); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b) }
const handleAudioService = async (request, response, readBody, send, env = process.env) => {
  if (!tokenMatches(request.headers.authorization?.replace(/^Bearer /, ''), env.S2T_AUDIO_SERVICE_TOKEN)) return send(response, 401, { error: 'Internal authentication required' })
  if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' })
  if (request.url === '/internal/audio/import') {
    const controller = new AbortController()
    response.once('close', () => { if (!response.writableFinished) controller.abort() })
    request.once('aborted', () => controller.abort())
    let converted
    try {
      converted = await convertImportAudio(request, { signal: controller.signal })
      response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': converted.size })
      await pipeline(createReadStream(converted.path), response, { signal: controller.signal })
    } finally { await converted?.dispose() }
    return
  }
  const name = request.url.replace('/internal/audio/', '')
  if (!allowed.includes(name)) return send(response, 404, { error: 'Unknown audio operation' })
  const args = decode(JSON.parse((await readBody(request, 140 * 1024 ** 2)).toString('utf8')))
  if (!Array.isArray(args) || args.length > 2) return send(response, 400, { error: 'Invalid arguments' })
  const value = await createLocalAudioOperations()[name](...args)
  return send(response, 200, { value: encode(value) })
}
const proxyImport = async (request, response, env = process.env) => {
  const controller = new AbortController()
  response.once('close', () => { if (!response.writableFinished) controller.abort() })
  request.once('aborted', () => controller.abort())
  const remote = await fetch(`${env.S2T_AUDIO_SERVICE_URL.replace(/\/$/, '')}/internal/audio/import`, { method: 'POST', headers: { authorization: `Bearer ${env.S2T_AUDIO_SERVICE_TOKEN}`, 'content-type': request.headers['content-type'] || 'application/octet-stream', ...(request.headers['content-length'] ? { 'content-length': request.headers['content-length'] } : {}) }, body: request, duplex: 'half', signal: controller.signal })
  response.writeHead(remote.status, { 'content-type': remote.headers.get('content-type') || 'application/json', ...(remote.headers.get('content-length') ? { 'content-length': remote.headers.get('content-length') } : {}) })
  if (remote.body) await pipeline(Readable.fromWeb(remote.body), response, { signal: controller.signal }); else response.end()
}

module.exports = { handleAudioService, proxyImport }
