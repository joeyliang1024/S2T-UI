// Exercise acceptance reporting, durable byte verification and credential gates.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os'), path = require('node:path')
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
;(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 's2t-runner-'))
  const recordings = new Map(); let deny = false, corrupt = false, calls = 0
  const server = createServer(async (request, response) => {
    try {
      const user = request.headers.authorization, parts = []
      for await (const part of request) parts.push(part)
      const body = Buffer.concat(parts)
      const json = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
      if (request.url === '/api/auth/session') { if (deny) { response.statusCode=401; return json({error:'test denial'}) }; return json({user:{id:user}}) }
      if (request.url === '/api/transcriptions' || request.url === '/api/translations') { calls++; await new Promise(resolve=>setTimeout(resolve,500)); return json({text:'caption'}) }
      const match = request.url.match(/^\/api\/data\/recordings\/([^/]+)(?:\/(chunks)\/(\d+)|\/(finish))?$/)
      if (match) {
        const key = user + ':' + match[1]
        if (request.method === 'PUT') {
          const value = recordings.get(key) || { chunks: [], bytes: 0 }
          assert.equal(Number(match[3]), value.chunks.length)
          assert.equal(Number(request.headers['x-s2t-start-sample']), value.bytes / 2)
          value.chunks.push(body); value.bytes += body.length; recordings.set(key,value)
          return json({durable:true,contiguousChunks:value.chunks.length,persistedSamples:value.bytes/2})
        }
        if (match[4]) { const value = recordings.get(key), data=JSON.parse(body); assert.equal(data.totalSamples,value.bytes/2); assert.equal(data.totalChunks,value.chunks.length); return json({saved:true}) }
        if (request.method === 'DELETE') { assert.ok(recordings.delete(key)); response.writeHead(204); return response.end() }
      }
      const audio = request.url.match(/^\/api\/data\/audio\/(.+)$/)
      if (audio) { const value=recordings.get(user+':'+audio[1]), pcm=Buffer.concat(value.chunks); const data=corrupt?Buffer.concat([pcm.subarray(64000),pcm.subarray(0,64000)]):pcm; return response.end(Buffer.concat([Buffer.alloc(44),data])) }
      response.writeHead(404); response.end()
    } catch (error) { if (!response.headersSent) { response.writeHead(500); response.end(error.message) } else response.destroy(error) }
  })
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server startup timeout')),3000);server.once('error',error=>{clearTimeout(timer);reject(error)});server.listen(0,'127.0.0.1',()=>{clearTimeout(timer);resolve()})})
  try {
    const credentials = path.join(directory,'tokens.json')
    await fs.writeFile(credentials,JSON.stringify(['test-user-a','test-user-b']))
    const run = async (name, preload, seconds=2) => {
      const report = path.join(directory,name+'.json')
      const child = spawn(process.execPath,[...(preload?['--require',preload]:[]),'scripts/benchmarks/recording-load.cjs'],{env:{...process.env,S2T_LOAD_BASE_URL:`http://127.0.0.1:${server.address().port}`,S2T_LOAD_TOKENS_FILE:credentials,S2T_LOAD_CONCURRENCY:'2',S2T_LOAD_DURATION_SECONDS:String(seconds),S2T_LOAD_CADENCE_MS:'1000',S2T_LOAD_REPORT:report,S2T_LOAD_START_AT:String(Date.now()+200)},stdio:['ignore','pipe','pipe']})
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk)
      const code = await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
      return {code,value:JSON.parse(await fs.readFile(report,'utf8')),output}
    }
    const healthy=await run('healthy')
    assert.equal(healthy.code,0,healthy.output);assert.equal(healthy.value.passed,true)
    assert.equal(healthy.value.timingValid,true);assert.ok(healthy.value.startSkewMs<500);assert.equal(healthy.value.verified,2);assert.equal(healthy.value.cleaned,2);assert.equal(recordings.size,0)
    const preload=path.join(directory,'block.cjs')
    await fs.writeFile(preload,'setTimeout(()=>{const end=Date.now()+1800;while(Date.now()<end){}},750)')
    const delayed=await run('delayed',preload)
    assert.equal(delayed.code,1);assert.equal(delayed.value.passed,false);assert.ok(delayed.value.dropped>0)
    assert.equal(delayed.value.verified,2);assert.equal(recordings.size,0)
    corrupt=true;const reordered=await run('reordered',undefined,4)
    assert.equal(reordered.code,1);assert.equal(reordered.value.verified,0);assert.equal(reordered.value.cleaned,0);assert.equal(recordings.size,2);recordings.clear();corrupt=false
    deny=true;const before=calls, rejected=await run('rejected')
    assert.equal(rejected.code,1);assert.equal(rejected.value.complete,false);assert.equal(calls,before)
    console.log('PASS load runner: 500ms models, complete byte verification/cleanup, reordering detection without deleting invalid audio, missed-deadline failure and credential preflight')
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true}) }
})().catch(error=>{console.error(error);process.exitCode=1})
