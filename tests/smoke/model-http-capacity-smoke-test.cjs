const assert=require('node:assert/strict'),{createServer}=require('node:http')
const {createModelFetch,createModelClient,modelHttpStats,closeModelHttp}=require('../../server/model-http.cjs')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
;(async()=>{
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/plain');response.write('first chunk'); const timer=setInterval(()=>response.write('next'),100);response.on('close',()=>clearInterval(timer))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 try{
  const options={apiKey:'first-key',baseURL:'http://127.0.0.1/v1'}
  const original=createModelClient('cache-test',options)
  assert.equal(createModelClient('cache-test',options),original)
  assert.notEqual(createModelClient('cache-test',{...options,apiKey:'rotated-key'}),original,'rotated credentials must not reuse a stale client')
  assert.notEqual(createModelClient('other-role',options),original,'role capacity remains independent')
  for(let i=0;i<65;i++)createModelClient('cache-test',{...options,apiKey:'bounded-key-'+i})
  assert.notEqual(createModelClient('cache-test',options),original,'SDK cache evicts old credential entries at its hard bound')
  const call=createModelFetch('abort-test'),cancel=new AbortController()
  await call(`http://127.0.0.1:${server.address().port}`,{signal:cancel.signal})
  assert.equal(modelHttpStats()['abort-test'].active,1,'stream holds capacity until body completion')
  cancel.abort(); await delay(50)
  assert.equal(modelHttpStats()['abort-test'].active,0,'aborted unconsumed response cannot leak an API permit')
  assert.equal(createModelFetch('abort-test'),call,'requests share a bounded role pool')
 }finally{await closeModelHttp();server.closeAllConnections();await new Promise(r=>server.close(r))}
 console.log('PASS model HTTP streaming owns capacity, cancellation releases unconsumed bodies, and role pools are reused')
})().catch(error=>{console.error(error);process.exitCode=1})
