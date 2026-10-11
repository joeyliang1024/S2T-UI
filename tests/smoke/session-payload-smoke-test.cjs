const assert=require('node:assert/strict'),{createServer}=require('node:http'),{gzipSync}=require('node:zlib')
const {readSessionPayload,createSessionWriteGate,MAX_SESSION_BYTES}=require('../../server/session-payload.cjs')
;(async()=>{
 const server=createServer(async(req,res)=>{
  try{const body=await readSessionPayload(req);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({length:body.text.length}))}
  catch(e){res.writeHead(e.status||500,{'content-type':'application/json',connection:'close'});res.once('finish',()=>req.destroy());res.end(JSON.stringify({error:e.message}))}
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const url='http://127.0.0.1:'+server.address().port
 const post=(body,encoding)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(encoding?{'content-encoding':encoding}:{})},body})
 try{
  const body=JSON.stringify({text:'測試'.repeat(1100000)})
  assert.ok(Buffer.byteLength(body)>5*1024*1024)
  for(const [wire,encoding]of [[body,undefined],[gzipSync(body),'gzip']]){
   const r=await post(wire,encoding);assert.equal(r.status,200);assert.equal((await r.json()).length,2200000)
  }
  for(const [wire,encoding,status]of [[Buffer.alloc(MAX_SESSION_BYTES+1),undefined,413],[gzipSync(Buffer.alloc(MAX_SESSION_BYTES+1)),'gzip',413],[Buffer.from('broken'),'gzip',400],['{}','br',415],['{',undefined,400]]){
   const r=await post(wire,encoding);assert.equal(r.status,status);assert.equal(typeof(await r.json()).error,'string')
  }
  assert.equal((await post('{"text":"healthy"}')).status,200)
  const gate=createSessionWriteGate(1,1,30)
  let done;const held=gate(()=>new Promise(r=>done=r))
  const queued=gate(async()=>2)
  const expired=assert.rejects(queued,e=>e.status===503)
  await assert.rejects(gate(async()=>3),e=>e.status===503)
  await expired;done(1);assert.equal(await held,1);assert.equal(await gate(async()=>4),4)
  console.log('PASS large plain/gzip JSON, expansion bounds, structured 413/415/400, healthy connection, bounded write admission and recovery')
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1})
