const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createAdaptiveCapacity } = require('../../server/adaptive-capacity.cjs')
const { runWithWorkload, workloadForRequest } = require('../../server/workload-context.cjs')
const { createModelFetch, modelHttpStats, closeModelHttp } = require('../../server/model-http.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  const capacity = createAdaptiveCapacity({ minimum:4, maximum:4, initial:4, backgroundMaximum:1 })
  const background = await capacity.acquire({ priority:'background' })
  let bgGranted = false
  const queued = capacity.acquire({ priority:'background' }).then(release => { bgGranted = true; return release })
  const live = await Promise.all(Array.from({length:3}, () => capacity.acquire()))
  const order = []
  const next = capacity.acquire().then(release => { order.push('realtime'); return release })
  live[0](); const nextRelease = await next
  assert.deepEqual(order,['realtime']); assert.equal(bgGranted,false,'background cannot consume reserved capacity')
  assert.equal(capacity.stats().active,4,'no active request is preempted')
  background(); (await queued)(); nextRelease(); live[1](); live[2]()
  const held = await capacity.acquire({ priority:'background' }), cancel = new AbortController()
  const aborted = capacity.acquire({ priority:'background',signal:cancel.signal })
  cancel.abort(); await assert.rejects(aborted,{name:'AbortError'})
  assert.equal(capacity.stats().backgroundWaiting,0)
  held(); capacity.close()
  assert.equal(workloadForRequest({url:'/api/summaries',headers:{'x-s2t-workload':'realtime'}}),'background','summary cannot promote itself')
  assert.equal(workloadForRequest({url:'/api/transcriptions',headers:{'x-s2t-workload':'background'}}),'background')
  assert.equal(workloadForRequest({url:'http://[',headers:{}}),'realtime','malformed URL must not escape the HTTP listener')
  process.env.S2T_MODEL_HTTP_MAX_CONNECTIONS='4'
  process.env.S2T_BACKGROUND_MAX_INFLIGHT='1'
  const seen=[]
  const server=createServer((request,response)=>{
    seen.push(request.headers['x-s2t-workload'])
    if(request.url==='/hold'){response.write('open');return}
    response.end('ok')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const url=`http://127.0.0.1:${server.address().port}`, fetch=createModelFetch('asr')
    const first=await runWithWorkload('background',()=>fetch(url+'/hold'))
    const controller=new AbortController()
    const waiting=runWithWorkload('background',()=>fetch(url+'/queued',{signal:controller.signal}))
    await delay(15)
    assert.equal(modelHttpStats().asr.backgroundWaiting,1)
    const response=await runWithWorkload('realtime',()=>fetch(url+'/live'))
    assert.equal(await response.text(),'ok','live completes while older background waits')
    assert.equal(modelHttpStats().asr.backgroundActive,1,'stream keeps its background slot')
    controller.abort(); await assert.rejects(waiting,{name:'AbortError'})
    await first.body.cancel(); await delay(15)
    assert.equal(modelHttpStats().asr.active,0)
    assert.deepEqual(seen,['background','realtime'],'queued cancelled work never reaches upstream')
  } finally { await closeModelHttp();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)) }
  console.log('PASS realtime priority, background reserve, stream ownership, cancellation and workload context isolation')
})().catch(error=>{console.error(error);process.exitCode=1})
