// Compare different identities, not different enrollment samples of one person.
const identityKey = (candidate) => String(candidate?.NT || '').trim().toLowerCase()

const identityCandidates = (matches) => {
  const identities = new Map()
  for (const match of matches) {
    if (typeof match.NT !== 'string' || !match.NT.trim() || !Number.isFinite(match.score)) continue
    const identity = identityKey(match)
    if (!identities.has(identity) || identities.get(identity).score < match.score) identities.set(identity, match)
  }
  return [...identities.values()].sort((a, b) => b.score - a.score)
}

// Raw top-k rows across every authorized enrollment. The gateway needs the
// row ids of the leading identities so it can verify the remaining blocks
// against exactly those candidates instead of searching the library again.
const findMatches = async (store, embedding, allowedIds) => {
  const matches = []
  const ids = [...new Set(allowedIds)]
  // A single top-2 search may return two enrollments of the same identity,
  // hiding the true runner-up. Bound each REST search while considering all
  // authorized enrollments, never an unfiltered global candidate set.
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50)
    matches.push(...await store.nearest(embedding, batch.length, batch))
  }
  return matches.sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
}

const findIdentityCandidates = async (store, embedding, allowedIds) => identityCandidates(await findMatches(store, embedding, allowedIds))

const median = (values) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * A first block that is far ahead of every other identity needs no further
 * evidence; only ambiguous speakers pay for the remaining blocks.
 */
const fastMatch = (candidates, { fastScore = 0.75, fastMargin = 0.15 } = {}) => {
  const best = candidates[0]
  if (!best) return null
  const runnerUp = candidates[1]
  return best.score >= fastScore && (!runnerUp || best.score - runnerUp.score >= fastMargin) ? best : null
}

/**
 * Decide whether one diarized speaker may be labelled with an NT.
 *
 * @param {Array} candidates identities ranked by their first-block score
 * @param {Array<Array<number>>} blockScores blockScores[i] holds every
 *   evaluated score of candidates[i] (first block first)
 * @returns {{ accepted: boolean, candidate?: object, path?: string,
 *   reason?: string, detail: object }}
 *
 * Rejection is deliberate: an anonymous turn stays correct, a wrong NT does
 * not. `minBlocks` independent blocks must clear `threshold` unless the first
 * block is already unambiguous on its own (`fastScore` + `fastMargin`).
 */
const decideIdentity = ({ candidates, blockScores, threshold, margin, minBlocks = 2, fastScore = 0.75, fastMargin = 0.15 }) => {
  const describe = (candidate) => candidate ? { NT: candidate.NT, score: Math.round(candidate.score * 1_000) / 1_000 } : null
  if (!candidates.length) return { accepted: false, reason: 'no-candidate', detail: {} }
  const fast = fastMatch(candidates, { fastScore, fastMargin })
  if (fast) return { accepted: true, candidate: fast, path: 'fast', detail: { top1: describe(fast), top2: describe(candidates[1]) } }
  const ranked = candidates
    .map((candidate, index) => {
      const values = blockScores[index] && blockScores[index].length ? blockScores[index] : [candidate.score]
      const consensus = median(values)
      return { candidate: { ...candidate, score: consensus }, consensus, values, hits: values.filter((value) => value >= threshold).length }
    })
    .sort((left, right) => right.consensus - left.consensus)
  const winner = ranked[0]
  const second = ranked[1]
  const gap = winner.consensus - (second ? second.consensus : 0)
  const detail = {
    top1: { NT: winner.candidate.NT, score: Math.round(winner.consensus * 1_000) / 1_000 },
    top2: second ? { NT: second.candidate.NT, score: Math.round(second.consensus * 1_000) / 1_000 } : null,
    margin: Math.round(gap * 1_000) / 1_000,
    hits: winner.hits,
    evaluated: winner.values.length
  }
  if (winner.consensus < threshold) return { accepted: false, reason: 'below-threshold', detail }
  if (winner.hits < minBlocks) return { accepted: false, reason: 'insufficient-hits', detail }
  if (second && gap < margin) return { accepted: false, reason: 'margin', detail }
  return { accepted: true, candidate: winner.candidate, path: 'consensus', detail }
}

module.exports = { identityCandidates, findIdentityCandidates, findMatches, decideIdentity, fastMatch, median, identityKey }
