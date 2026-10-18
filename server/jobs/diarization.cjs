const { loadSessionSnapshot } = require('../session-snapshot.cjs')
const { matchesJob, finalizeDiarizationSession } = require('../diarization-session.cjs')

// The caller owns scheduling, admission and shutdown. One invocation owns one lease.
const createDiarizationJobRunner = ({ storage, logger, diarizationJobMaxAttempts, diarization, accountModelService, diarizeWav, labelDiarizationTurns, diarizationTurns, resolveLocalDiarizationModel, setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval }) => {
const runDurableDiarizationJob = async (auth, owner) => {
  if (typeof storage.config.claimDiarizationJob !== 'function') return
  const job = await storage.config.claimDiarizationJob(owner)
  if (!job) return
  const execute = async () => {
  if (job.attempts > diarizationJobMaxAttempts) {
    logger.warn('diarization.job.abandoned', { jobId: job.id, attempt: job.attempts, maxAttempts: diarizationJobMaxAttempts, owner })
    await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration, `超過最大重試次數（${diarizationJobMaxAttempts}）`).catch(() => undefined)
    return
  }
  let leaseLost = false
  let renewingLease = false
  const leaseTimer = typeof storage.config.renewDiarizationJob === 'function' ? schedule(() => {
    if (renewingLease || leaseLost) return
    renewingLease = true
    storage.config.renewDiarizationJob(job.id, owner, job.leaseGeneration)
      .then(owned => { if (!owned) leaseLost = true })
      .catch(error => { leaseLost = true; logger.warn('diarization.job.renew.failed', { jobId: job.id, error }) })
      .finally(() => { renewingLease = false })
  }, 30000) : null
  leaseTimer?.unref()
  const jobStartedAt = Date.now()
  logger.info('diarization.job.started', { jobId: job.id, attempt: job.attempts, sessionId: job.sessionId, owner })
  try {
    const user = job.payload?.user
    if (!user?.id || user.id !== job.userId) throw new Error('工作使用者資料無效')
    const initial = await loadSessionSnapshot(storage.config, user.id)
    const target = initial?.sessions?.find(session => session.id === job.sessionId)
    if (!target) throw new Error('retry:紀錄尚未同步完成')
    if (job.payload?.processingToken && target.processingToken === job.payload.processingToken && target.processingStage !== 'diarization' && target.processingState === 'running') throw new Error('retry:紀錄尚未完成尾段處理')
    if (!matchesJob(target, job)) {
      if (job.payload?.processingToken && target.processingToken !== job.payload.processingToken) {
        await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration)
        return
      }
      throw new Error('retry:紀錄音訊版本尚未同步完成')
    }

    const audio = await storage.blob.get(user.id, `audio/${job.audioKey}`)
    if (!audio) throw new Error('找不到講者分離工作對應的音檔')
    // Background jobs use the deployment service before account defaults.
    const selected = job.payload?.localModel ? null : diarization.model ? diarization : await accountModelService(auth, user, job.payload?.modelId || 'managed-diarization', 'diarization')
    let rawTurns
    if (selected?.endpoint && selected.model) {
      const headers = selected.apiKey ? { authorization: `Bearer ${selected.apiKey}` } : {}
      const form = new FormData(); form.set('model', selected.model); form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
      const remote = await fetch(selected.endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(120_000) })
      const payload = await remote.json().catch(() => null)
      if (!remote.ok || !payload) throw new Error(`講者分離服務 HTTP ${remote.status}`)
      rawTurns = diarizationTurns(payload)
    } else rawTurns = await diarizeWav(audio, resolveLocalDiarizationModel(job.payload?.localModel))
    const turns = await labelDiarizationTurns(user, audio, rawTurns)
    if (!turns.length) throw new Error('講者分離服務沒有回傳有效區段')
    const stored = await loadSessionSnapshot(storage.config, user.id)
    const sessions = Array.isArray(stored?.sessions) ? stored.sessions : []
    const version = Number.isSafeInteger(stored?.version) ? stored.version : 0
    let matched = false
    const next = sessions.map((session) => {
      if (!matchesJob(session, job)) return session
      matched = true
      return finalizeDiarizationSession(session, job, turns)
    })
    if (!matched) throw new Error('retry:紀錄尚未同步完成')
    if (leaseLost) return
    const committed = await storage.config.commitDiarizationJob(job.id, owner, job.leaseGeneration, user.id, version, { sessions: next, version: version + 1 })
    if (committed === 'lost') return
    if (committed === 'conflict') throw new Error('retry:紀錄已更新，背景工作將重試')
    logger.info('diarization.job.completed', { jobId: job.id, attempt: job.attempts, durationMs: Date.now() - jobStartedAt, turns: turns.length })
  } catch (error) {
    const reason = error instanceof Error ? error.message : '背景講者分離失敗'
    const fields = { jobId: job.id, attempt: job.attempts, durationMs: Date.now() - jobStartedAt, error }
    // A job that lost a race or has not synced yet is expected to retry; a
    // real failure is an error so an operator sees it without debug logging.
    if (reason.startsWith('retry:')) logger.warn('diarization.job.retry', fields)
    else logger.error('diarization.job.failed', fields)
    if (!leaseLost) await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration, reason)
  } finally { if (leaseTimer) cancel(leaseTimer) }
  }
  // Keep already-claimed work inside the same account admission as HTTP writes.
  // Deletion waits for this lease before touching blobs, vectors or sessions.
  if (typeof storage.withAccountWrite !== 'function') return execute()
  try { return await storage.withAccountWrite(job.userId, execute) }
  catch (error) {
    if (!['ACCOUNT_DELETING', 'ACCOUNT_UNAVAILABLE'].includes(error.code)) throw error
    logger.info('diarization.job.account-unavailable', { jobId: job.id, userId: job.userId })
  }
}
return runDurableDiarizationJob
}
module.exports = { createDiarizationJobRunner }
