const assert = require('node:assert/strict')
const http = require('node:http')
const { streamSummary } = require('../../server/summary-stream.cjs')
const ts = require('typescript')
const fs = require('node:fs')
const code = ts.transpileModule(fs.readFileSync('src/renderer/src/features/app/services/summary-stream.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const mod = { exports: {} }; new Function('exports', code)(mod.exports)
;(async () => {
  let requests = 0; let first
  const mock = http.createServer(async (req,res) => {
    requests++; let raw=''; for await (const piece of req) raw+=piece
    assert.equal(JSON.parse(raw).stream, true)
    res.writeHead(200, {'content-type':'text/event-stream'})
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'# 摘要'}}]})+'\n\n')
    await new Promise(r=>setTimeout(r,150))
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'\n完成'}}]})+'\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(r=>mock.listen(0,'127.0.0.1',r))
  const gateway=http.createServer((req,res)=>streamSummary(req,res,{apiKey:'fake',model:'fake'},[{role:'user',content:'test'}],`http://127.0.0.1:${mock.address().port}/v1`))
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r))
  try {
    const changes=[]; const start=Date.now()
    const result=await mod.exports.readSummaryStream(await fetch(`http://127.0.0.1:${gateway.address().port}`),text=>{changes.push(text);first??=Date.now()})
    assert.deepEqual(changes,['# 摘要','# 摘要\n完成']);assert.equal(result.text,changes[1]);assert.equal(requests,1);assert.ok(Date.now()-first>=100)
    await assert.rejects(mod.exports.readSummaryStream(new Response('{"delta":"partial"}\n'),()=>{}),/before completion/)
    await assert.rejects(mod.exports.readSummaryStream(new Response('{"error":"fixture failure"}\n'),()=>{}),/fixture failure/)
    const encoded=new TextEncoder().encode('{"delta":"繁體中文"}\n{"done":true}\n')
    const fragmented=new ReadableStream({start(c){for(const b of encoded)c.enqueue(Uint8Array.of(b));c.close()}})
    assert.equal((await mod.exports.readSummaryStream(new Response(fragmented),()=>{})).text,'繁體中文')
    console.log(JSON.stringify({passed:true,upstreamRequests:requests,incremental:true,fragmentedUtf8:true,truncatedStreamRejected:true,elapsedMs:Date.now()-start}))
  } finally { gateway.closeAllConnections();mock.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>mock.close(r))]) }
})().catch(e=>{console.error(e);process.exitCode=1})
