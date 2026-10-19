const { createLocalAudioOperations } = require('./clients/local.cjs')
const { createRemoteAudioOperations } = require('./clients/remote.cjs')
const createAudioClient = (env = process.env) => {
  const operations = env.S2T_PROCESS_ROLE === 'api' && env.S2T_AUDIO_SERVICE_URL
    ? createRemoteAudioOperations(env) : createLocalAudioOperations()
  // Operational diagnostics are explicit; worker internals are not spread into the client API.
  const { modelPaths, audioWorkerPool } = require('../audio-worker-pool.cjs')
  return { ...operations, modelPaths, audioWorkerPool }
}
module.exports = { createAudioClient }
