// Compare different identities, not different enrollment samples of one person.
const identityCandidates = (matches) => {
  const identities = new Map()
  for (const match of matches) {
    if (typeof match.NT !== 'string' || !match.NT.trim() || !Number.isFinite(match.score)) continue
    const identity = match.NT.trim().toLowerCase()
    if (!identities.has(identity) || identities.get(identity).score < match.score) identities.set(identity, match)
  }
  return [...identities.values()].sort((a, b) => b.score - a.score)
}
const findIdentityCandidates = async (store, embedding, allowedIds) => {
  const matches = []
  const ids = [...new Set(allowedIds)]
  // A single top-2 search may return two enrollments of the same identity,
  // hiding the true runner-up. Bound each REST search while considering all
  // authorized enrollments, never an unfiltered global candidate set.
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50)
    matches.push(...await store.nearest(embedding, batch.length, batch))
  }
  return identityCandidates(matches)
}
module.exports = { identityCandidates, findIdentityCandidates }
