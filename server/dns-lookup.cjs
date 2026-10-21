const { lookup } = require('node:dns')
// DNS lookups use libuv's small worker pool. A socket burst to the same model
// must not enqueue hundreds of identical getaddrinfo jobs ahead of PG/Sentinel.
const createCachedLookup = ({ resolve = lookup, ttlMs = 5000, maximum = 128, now = Date.now } = {}) => {
  const cache = new Map(), pending = new Map()
  const deliver = (entry, records, callback, all) => {
    // Preserve the resolver's preferred address family. Rotate only peers
    // within that family, avoiding gratuitous IPv6 fallback delays.
    const preferred = records.filter(record => record.family === records[0].family)
    const remaining = records.filter(record => record.family !== records[0].family)
    const offset = entry.cursor++ % preferred.length
    const ordered = [...preferred.slice(offset), ...preferred.slice(0, offset), ...remaining].map(record => ({ ...record }))
    queueMicrotask(() => all ? callback(null, ordered) : callback(null, ordered[0].address, ordered[0].family))
  }
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {} }
    if (typeof options === 'number') options = { family: options }
    options ||= {}
    const { all = false, ...query } = options
    const key = JSON.stringify([hostname, query.family || 0, query.hints || 0, query.order, query.verbatim])
    const hit = cache.get(key)
    if (hit && hit.until > now()) { deliver(hit, hit.records, callback, all); return }
    if (pending.has(key)) { pending.get(key).push({ callback, all }); return }
    pending.set(key, [{ callback, all }])
    resolve(hostname, { ...query, all: true }, (error, records) => {
      const waiters = pending.get(key); pending.delete(key)
      if (!error && (!Array.isArray(records) || !records.length)) error = Object.assign(new Error('DNS returned no addresses'), { code: 'ENOTFOUND' })
      if (error) { for (const waiter of waiters) waiter.callback(error); return }
      const entry = { records, until: now() + ttlMs, cursor: 0 }
      cache.delete(key)
      while (cache.size >= maximum) cache.delete(cache.keys().next().value)
      cache.set(key, entry)
      for (const waiter of waiters) deliver(entry, records, waiter.callback, waiter.all)
    })
  }
}
module.exports = { createCachedLookup, cachedLookup: createCachedLookup() }
