const createRecordingRoutes = ({ recordingChunks, readBody, send, storage, withProtectedAudioUpload }) => async (request, response, auth) => {
  const storagePath = new URL(request.url, 'http://localhost').pathname
  const recordingMatch = /^\/api\/data\/recordings\/([A-Za-z0-9._-]{1,120})(?:\/(chunks)\/(\d+)|(\/(?:finish|promote)))?$/.exec(storagePath)
  if (!recordingMatch) return false
  await (async () => {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const id = recordingMatch[1]
    try {
      if (request.method === 'DELETE' && !recordingMatch[2] && !recordingMatch[4]) { await recordingChunks.removeCompleted(user.id, id); return send(response, 204, '') }
      if (request.method === 'GET' && !recordingMatch[2] && !recordingMatch[4]) {
        const value = await recordingChunks.status(user.id, id)
        return value ? send(response, 200, { sampleRate: value.sampleRate, state: value.state, contiguousChunks: value.contiguousChunks, persistedSamples: value.persistedSamples, audioKey: value.audioKey }) : send(response, 404, { error: '找不到錄音' })
      }
      if (request.method === 'PUT' && recordingMatch[2]) {
        const audio = await readBody(request, 1024 ** 2)
        return send(response, 200, await recordingChunks.append(user.id, id, Number(recordingMatch[3]), Number(request.headers['x-s2t-start-sample']), Number(request.headers['x-s2t-sample-rate']), audio))
      }
      if (request.method === 'POST' && recordingMatch[4] === '/promote') {
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
        if (typeof body.audioKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(body.audioKey) || body.audioKey === id) return send(response, 400, { error: '無效的正式音訊 ID' })
        const value = await recordingChunks.status(user.id, id)
        if (value?.state !== 'completed') return send(response, 409, { error: '錄音尚未完成' })
        await withProtectedAudioUpload(user, body.audioKey, async () => {
          if (typeof storage.blob.copy === 'function') {
            // Server-side S3 copy avoids holding hundreds of download sockets
            // while waiting for the upload pool and retransmitting whole WAVs.
            await storage.blob.copy(user.id, `audio/${id}`, `audio/${body.audioKey}`)
          } else {
            const audio = await storage.blob.readStream(user.id, `audio/${id}`)
            if (!audio) throw Object.assign(new Error('錄音備份暫時不可用'), { status: 503 })
            await storage.blob.putStream(user.id, `audio/${body.audioKey}`, audio, value.persistedSamples * 2 + 44)
          }
        })
        return send(response, 201, { saved: true, pendingSessionCommit: true })
      }
      if (request.method === 'POST' && recordingMatch[4]) {
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
        return send(response, 200, await recordingChunks.finish(user.id, id, body.totalChunks, body.totalSamples))
      }
      return send(response, 405, { error: 'Method not allowed' })
    } catch (error) { return send(response, error.status || (error instanceof SyntaxError ? 400 : 503), { error: error.message }) }
  })()
  return true
}
module.exports = { createRecordingRoutes }
