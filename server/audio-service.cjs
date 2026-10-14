// Stable entrypoint while callers migrate to explicit audio/http boundaries.
const { createAudioClient } = require('./audio/client.cjs')
const { handleAudioService, proxyImport } = require('./http/internal-audio.cjs')
module.exports = { createAudioClient, handleAudioService, proxyImport }
