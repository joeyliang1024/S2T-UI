const fs = require('node:fs'), assert = require('node:assert/strict')
;(async () => {
 const user=JSON.parse(fs.readFileSync('/tmp/stress-users.json'))[0]
 const stats=async()=>fetch('http://mock-models:9090/stats').then(r=>r.json())
 const before=await stats(), start=Date.now()
 const response=await fetch('http://'+process.argv[2]+':8787/api/transcriptions',{
  method:'POST',headers:{authorization:'Bearer '+user.token,'content-type':'audio/wav'},
  body:Buffer.alloc(48044),signal:AbortSignal.timeout(16000)
 })
 const durationMs=Date.now()-start, body=await response.json(),after=await stats()
 assert.equal(response.status,503)
 assert.ok(durationMs >= 9500 && durationMs < 14500)
 assert.equal(after.counts.asr,before.counts.asr,'Redis unavailable must not bypass shared coordination')
 console.log(JSON.stringify({passed:true,status:response.status,durationMs,modelCalls:after.counts.asr-before.counts.asr,error:body.error}))
})().catch(e=>{console.error(e);process.exitCode=1})
