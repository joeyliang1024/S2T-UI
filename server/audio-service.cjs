const { timingSafeEqual } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { createReadStream } = require('node:fs')
const local = require('./sherpa-worker-pool.cjs')
const { transcodeM4a } = require('./audio-preprocess.cjs')
const { convertImportAudio } = require('./import-audio.cjs')
const allowed = ['assessVoiceprintSample', 'extractSpeakerEmbedding', 'extractDiarizedSpeakerBlocks', 'extractSpeakerLabelEmbeddings', 'diarizeWav', 'nemotronStatus', 'analyzeSileroVad', 'warmSileroVad', 'dynaudnormWav', 'audioPreprocessStatus', 'transcodeM4a']
const tokenMatches = (actual, expected) => { const a = Buffer.from(actual || ''), b = Buffer.from(expected || ''); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b) }
const encode = value => ArrayBuffer.isView(value) && !Buffer.isBuffer(value) ? Array.from(value) : Buffer.isBuffer(value) ? { __s2tBuffer: value.toString('base64') } : Array.isArray(value) ? value.map(encode) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) : value
const decode = value => value && typeof value.__s2tBuffer === 'string' ? Buffer.from(value.__s2tBuffer, 'base64') : Array.isArray(value) ? value.map(decode) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)])) : value
const createAudioClient = (env = process.env) => {
  const endpoint = (env.S2T_AUDIO_SERVICE_URL || '').replace(/\/$/, '')
  if (env.S2T_PROCESS_ROLE !== 'api' || !endpoint) return { ...local, transcodeM4a }
  const client = { ...local }
  for (const name of allowed) client[name] = async (...args) => {
    const response = await fetch(`${endpoint}/internal/audio/${name}`, { method: 'POST', headers: { authorization: `Bearer ${env.S2T_AUDIO_SERVICE_TOKEN || ''}`, 'content-type': 'application/json' }, body: JSON.stringify(encode(args)), signal: AbortSignal.timeout(120000) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '音訊服務暫時不可用')
    return decode(result.value)
  }
  return client
}
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
  const value = await (name === 'transcodeM4a' ? transcodeM4a : local[name])(...args)
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
module.exports = { createAudioClient, handleAudioService, proxyImport }
