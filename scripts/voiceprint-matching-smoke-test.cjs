const assert = require('node:assert/strict')
const { identityCandidates, findIdentityCandidates, findMatches, decideIdentity, fastMatch } = require('../server/voiceprint-matching.cjs')

const records = [
  { id: 'a-1', NT: 'Alice', score: 0.91 },
  { id: 'a-2', NT: 'Alice', score: 0.89 },
  { id: 'b-1', NT: 'Bob', score: 0.88 },
  { id: 'c-1', NT: 'Carol', score: 0.63 }
]
assert.deepEqual(identityCandidates(records).map((item) => [item.NT, item.score]), [['Alice', 0.91], ['Bob', 0.88], ['Carol', 0.63]])

const store = { nearest: async (_embedding, _limit, ids) => records.filter((item) => ids.includes(item.id)) }
findIdentityCandidates(store, [1, 0], records.map((item) => item.id)).then(async (candidates) => {
  assert.equal(candidates[0].NT, 'Alice')
  assert.equal(candidates[1].NT, 'Bob', 'the margin must compare another identity, not Alice’s second enrollment')

  const raw = await findMatches(store, [1, 0], records.map((item) => item.id))
  assert.equal(raw.length, 4, 'raw matches keep every row so later blocks can target their ids')
  assert.equal(raw[0].NT, 'Alice')

  const options = { threshold: 0.65, margin: 0.05, minBlocks: 2, fastScore: 0.75, fastMargin: 0.15 }

  // Unambiguous first block: accepted without consulting further blocks.
  assert.equal(fastMatch([{ NT: 'Alice', score: 0.9 }], options)?.NT, 'Alice')
  assert.equal(fastMatch([{ NT: 'Alice', score: 0.9 }, { NT: 'Bob', score: 0.88 }], options), null, 'two close identities are never a fast match')
  const fast = decideIdentity({ candidates: [{ NT: 'Alice', score: 0.9 }, { NT: 'Bob', score: 0.6 }], blockScores: [[0.9], [0.6]], ...options })
  assert.equal(fast.accepted, true)
  assert.equal(fast.path, 'fast')

  // Consensus: two independent blocks above the threshold accept.
  const consensus = decideIdentity({ candidates: [{ NT: 'Alice', score: 0.7 }, { NT: 'Bob', score: 0.6 }], blockScores: [[0.7, 0.72], [0.6, 0.61]], ...options })
  assert.equal(consensus.accepted, true)
  assert.equal(consensus.path, 'consensus')
  assert.equal(consensus.candidate.NT, 'Alice')

  // A single evaluated block cannot reach the consensus requirement.
  const single = decideIdentity({ candidates: [{ NT: 'Alice', score: 0.7 }, { NT: 'Bob', score: 0.6 }], blockScores: [[0.7], [0.6]], ...options })
  assert.equal(single.accepted, false)
  assert.equal(single.reason, 'insufficient-hits')

  // One weak block among the evidence drags the median under the threshold.
  const weak = decideIdentity({ candidates: [{ NT: 'Alice', score: 0.7 }], blockScores: [[0.7, 0.4]], ...options })
  assert.equal(weak.accepted, false)
  assert.equal(weak.reason, 'below-threshold')

  // Close runner-up is rejected even when the median clears the threshold.
  const tight = decideIdentity({ candidates: [{ NT: 'Alice', score: 0.7 }, { NT: 'Bob', score: 0.69 }], blockScores: [[0.7, 0.71], [0.69, 0.7]], ...options })
  assert.equal(tight.accepted, false)
  assert.equal(tight.reason, 'margin')

  console.log('Voiceprint identity matching smoke test passed.')
}).catch((error) => { console.error(error); process.exitCode = 1 })
