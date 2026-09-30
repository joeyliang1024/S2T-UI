const assert = require('node:assert/strict')
const { identityCandidates, findIdentityCandidates } = require('../server/voiceprint-matching.cjs')

const records = [
  { id: 'a-1', NT: 'Alice', score: 0.91 },
  { id: 'a-2', NT: 'Alice', score: 0.89 },
  { id: 'b-1', NT: 'Bob', score: 0.88 },
  { id: 'c-1', NT: 'Carol', score: 0.63 }
]
assert.deepEqual(identityCandidates(records).map((item) => [item.NT, item.score]), [['Alice', 0.91], ['Bob', 0.88], ['Carol', 0.63]])

const store = { nearest: async (_embedding, _limit, ids) => records.filter((item) => ids.includes(item.id)) }
findIdentityCandidates(store, [1, 0], records.map((item) => item.id)).then((candidates) => {
  assert.equal(candidates[0].NT, 'Alice')
  assert.equal(candidates[1].NT, 'Bob', 'the margin must compare another identity, not Alice’s second enrollment')
  console.log('Voiceprint identity matching smoke test passed.')
}).catch((error) => { console.error(error); process.exitCode = 1 })
