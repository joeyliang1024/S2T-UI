// Native sherpa-onnx inference is synchronous and CPU-bound.  Keep it out of
// the HTTP event loop: this worker owns its own lazy model instances.
const { parentPort } = require('node:worker_threads')
const sherpa = require('./sherpa-diarization.cjs')
const silero = require('./silero-vad.cjs')
const preprocess = require('./audio-preprocess.cjs')

const operations = {
  assessVoiceprintSample: ({ audio }) => sherpa.assessVoiceprintSample(audio),
  extractSpeakerEmbedding: ({ audio }) => sherpa.extractSpeakerEmbedding(audio),
  extractDiarizedSpeakerEmbeddings: ({ audio, segments }) => sherpa.extractDiarizedSpeakerEmbeddings(audio, segments),
  diarizeWav: ({ audio }) => sherpa.diarizeWav(audio),
  sileroVad: ({ audio, options }) => silero.analyzeWav(audio, options),
  sileroStatus: () => silero.modelStatus(),
  dynaudnorm: ({ audio }) => preprocess.dynaudnormWav(audio),
  audioPreprocessStatus: () => ({ sileroVad: silero.modelStatus(), dynaudnorm: preprocess.dynaudnormStatus() })
}

parentPort.on('message', async ({ id, operation, payload }) => {
  try {
    const handler = operations[operation]
    if (!handler) throw new Error(`未知 sherpa worker 工作：${operation}`)
    // Structured clone restores Node Buffers as Uint8Array. Convert only at
    // the worker boundary so the native WAV reader keeps its Buffer contract.
    const normalized = payload?.audio ? { ...payload, audio: Buffer.from(payload.audio) } : payload
    parentPort.postMessage({ id, value: await handler(normalized || {}) })
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined } })
  }
})
