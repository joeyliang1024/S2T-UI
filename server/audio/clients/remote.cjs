const { allowed } = require('../operations.cjs')
const { encode, decode } = require('../codec.cjs')
const createRemoteAudioOperations = env => {
  const endpoint = env.S2T_AUDIO_SERVICE_URL.replace(/\/$/, '')
  return Object.fromEntries(allowed.map(name => [name, async (...args) => {
    const response = await fetch(`${endpoint}/internal/audio/${name}`, {
      method: 'POST', headers: { authorization: `Bearer ${env.S2T_AUDIO_SERVICE_TOKEN || ''}`, 'content-type': 'application/json' },
      body: JSON.stringify(encode(args)), signal: AbortSignal.timeout(120000)
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '音訊服務暫時不可用')
    return decode(result.value)
  }]))
}
module.exports = { createRemoteAudioOperations }
