const { allowed } = require('../operations.cjs')
const createLocalAudioOperations = () => {
  const worker = require('../../audio-worker-pool.cjs')
  const { transcodeM4a } = require('../../audio-preprocess.cjs')
  return Object.fromEntries(allowed.map(name => [name, name === 'transcodeM4a' ? transcodeM4a : worker[name]]))
}
module.exports = { createLocalAudioOperations }
