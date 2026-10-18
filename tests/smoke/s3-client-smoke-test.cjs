const assert = require('node:assert/strict')
const http = require('node:http')
const { Readable } = require('node:stream')
const { MinioBlobStore } = require('../../server/storage/remote.cjs')
;(async () => {
  let exists = false
  const objects = new Map(), clients = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture'), parts = url.pathname.split('/').filter(Boolean)
    const [bucket, ...keyParts] = parts, key = keyParts.map(decodeURIComponent).join('/')
    const xml = (status, body) => { response.writeHead(status, { 'content-type': 'application/xml' }); response.end(body) }
    if (bucket === 'denied') return xml(403, '<Error><Code>AccessDenied</Code></Error>')
    if (request.method === 'HEAD') { response.writeHead(exists ? 200 : 404); return response.end() }
    if (request.method === 'PUT' && !key) { exists = true; response.writeHead(200); return response.end() }
    if (request.method === 'GET' && !key) {
      const prefix = url.searchParams.get('prefix'), token = url.searchParams.get('continuation-token')
      const all = [...objects.keys()].filter(value => value.startsWith(prefix)), page = token ? all.slice(1) : all.slice(0, 1)
      const truncated = !token && all.length > 1
      return xml(200, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${truncated}</IsTruncated>${truncated ? '<NextContinuationToken>page-two</NextContinuationToken>' : ''}${page.map(value => `<Contents><Key>${value}</Key></Contents>`).join('')}</ListBucketResult>`)
    }
    if (request.method === 'PUT') { const chunks = []; for await (const chunk of request) chunks.push(chunk); objects.set(key, Buffer.concat(chunks)); response.writeHead(200, { etag: '"fixture"' }); return response.end() }
    if (request.method === 'DELETE') { objects.delete(key); response.writeHead(204); return response.end() }
    if (!objects.has(key)) return xml(404, '<Error><Code>NoSuchKey</Code><Message>Missing</Message></Error>')
    response.writeHead(200, { 'content-length': objects.get(key).length }); response.end(objects.get(key))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = { S2T_MINIO_ENDPOINT: `http://127.0.0.1:${server.address().port}`, S2T_MINIO_BUCKET: 'fixture', S2T_MINIO_ACCESS_KEY: 'fixture-only', S2T_MINIO_SECRET_KEY: 'fixture-secret-only' }
  try {
    const store = new MinioBlobStore(config); clients.push(store.client); await store.ready
    assert.equal(exists, true, 'missing bucket is initialized')
    await store.put('owner-a', 'one', Buffer.from('original'))
    const streamed = Buffer.alloc(300000, 97)
    await store.putStream('owner-a', 'two', Readable.from([streamed.subarray(0, 200000), streamed.subarray(200000)]), streamed.length)
    assert.equal((await store.get('owner-a', 'one')).toString(), 'original')
    const chunks = []; for await (const chunk of await store.readStream('owner-a', 'two')) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), streamed)
    assert.deepEqual(await store.list('owner-a'), ['one', 'two'], 'all S3 pages are read')
    assert.deepEqual(await store.list('owner-a', 'tw'), ['two'])
    assert.equal(await store.get('owner-b', 'one'), null, 'account prefix isolates objects')
    assert.equal(await store.readStream('owner-a', 'missing'), null)
    await assert.rejects(() => store.put('owner-a', '../outside', Buffer.from('bad')), /blob key/)
    await store.remove('owner-a', 'one'); assert.equal(await store.get('owner-a', 'one'), null)
    const denied = new MinioBlobStore({ ...config, S2T_MINIO_BUCKET: 'denied' }); clients.push(denied.client)
    await assert.rejects(() => denied.ready, error => error.$metadata?.httpStatusCode === 403)
    console.log('PASS real AWS S3 HTTP contract: bucket initialization, bytes/stream upload, download, pagination, missing objects, deletion, account isolation, path rejection and denied-bucket failure')
  } finally { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
