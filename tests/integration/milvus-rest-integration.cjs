const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { MilvusVectorStore } = require('../../server/storage/remote.cjs')

const main = async () => {
  const config = { S2T_MILVUS_ENDPOINT: 'http://127.0.0.1:29530', S2T_MILVUS_DB_NAME: 'default', S2T_MILVUS_TOKEN: 'root:Milvus', S2T_MILVUS_COLLECTION: `s2t_test_${randomUUID().replaceAll('-', '')}` }
  const store = new MilvusVectorStore(config)
  try {
    assert.equal(await store.hasCollection(), false)
    if (process.argv.includes('--legacy')) {
      await store.request('collections/create', { collectionName: store.collection, dimension: 4, primaryFieldName: 'id', idType: 'VarChar', vectorFieldName: 'embedding', metricType: 'COSINE', autoId: false, enableDynamicField: true, params: { max_length: '256', consistencyLevel: 'Bounded' } })
    }
    await Promise.all([store.ensureCollection(4), new MilvusVectorStore(config).ensureCollection(4)])
    const own = { id: 'own', NT: 'user-a', Department: 'test', embedding: [1, 0, 0, 0] }
    await store.upsert(own)
    await store.upsert({ ...own, id: 'other', NT: 'user-b' })
    assert.equal((await store.nearest(own.embedding, 5, ['own']))[0]?.NT, 'user-a')
    assert.deepEqual(await store.nearest(own.embedding, 5, []), [])
    assert.deepEqual((await store.getMany(['own']))[0], own)
    await store.upsert({ ...own, NT: 'updated' })
    assert.equal((await store.getMany(['own']))[0].NT, 'updated')
    await assert.rejects(store.ensureCollection(3), /維度不一致/)
    if (process.argv.includes('--restart')) {
      // Only this dedicated stack is ever restarted; never the user's stack.
      execFileSync('docker-compose', ['-f', 'docker-compose.milvus-test.yml', 'restart', 'milvus'], { stdio: 'inherit' })
      const deadline = Date.now() + 120_000
      for (;;) {
        try { await new MilvusVectorStore(config).ensureCollection(4); break } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
      assert.equal((await store.nearest(own.embedding, 5, ['own']))[0]?.NT, 'updated')
      assert.equal((await store.getMany(['own']))[0]?.NT, 'updated')
    }
    await store.remove('own')
    assert.deepEqual(await store.getMany(['own']), [])
    assert.deepEqual(await store.nearest(own.embedding, 5, ['own']), [])
    console.log('Milvus 2.5.3 REST integration passed: concurrent create, load, upsert/update, query, filtered search, dimensions, delete' + (process.argv.includes('--legacy') ? ', legacy bounded-read fallback' : '') + (process.argv.includes('--restart') ? ', restart persistence' : ''))
  } finally {
    await store.request('collections/drop', { collectionName: store.collection })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
