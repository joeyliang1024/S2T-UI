// Pure finalization: preserves translations/manual labels and the active audio snapshot.
const matchesJob = (session, job) => session?.id === job.sessionId
  && (!job.payload?.processingToken || session.processingToken === job.payload.processingToken)
  && (session.activeAudioVersionId
    ? session.audioVersions?.some(item => item.id === session.activeAudioVersionId && item.audioKey === job.audioKey)
    : session.audioKey === job.audioKey)
const finalizeDiarizationSession = (session, job, turns) => {
  if (!matchesJob(session, job)) return session
  const segments = (session.segments || []).map(entry => {
    if (entry.status !== 'final' || entry.speakerManuallyEdited) return entry
    let winner; let amount = 0
    for (const turn of turns) {
      const shared = Math.max(0, Math.min(entry.endMs, turn.end * 1000) - Math.max(entry.startMs, turn.start * 1000))
      if (shared > amount) { amount = shared; winner = turn }
    }
    return winner && amount / Math.max(1, entry.endMs - entry.startMs) >= .35
      ? { ...entry, speaker: winner.speaker, Department: winner.Department, revision: (entry.revision || 0) + 1 } : entry
  })
  const timestamp = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
  const transcript = segments.filter(entry => entry.status === 'final').map(entry => `[${timestamp(entry.startMs)}] ${entry.speaker?.trim() || '未標記講者'}：${entry.sourceText}${entry.translatedText ? `\n${entry.translatedText}` : ''}`).join('\n\n')
  const audioVersions = session.audioVersions?.map(item => item.id === (session.activeAudioVersionId || 'original') ? { ...item, segments, transcript } : item)
  return { ...session, segments, transcript, ...(audioVersions ? { audioVersions } : {}),
    processingState: session.processingError ? 'failed' : 'completed', processingStage: undefined }
}
module.exports = { matchesJob, finalizeDiarizationSession }
