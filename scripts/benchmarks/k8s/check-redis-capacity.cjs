const assert = require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {createSharedLimits}=require('/app/server/shared-limits.cjs')
const limits=createSharedLimits(process.env,{transcriptions:180})
;(async()=>{
 await limits.ready
 const run='lease-check-'+randomUUID(), began=performance.now()
 const results=await Promise.all(Array.from({length:500},(_,i)=>limits.accept(run+'-'+i,'transcriptions')))
 assert.ok(results.every(x=>x.accepted)); const admissionMs=performance.now()-began
 const one=await Promise.all(Array.from({length:181},()=>limits.accept(run,'transcriptions')))
 assert.equal(one.filter(x=>x.accepted).length,180,'per-user limit remains atomic across batches')
 await limits.health()
 const start=performance.now();let active=0,peak=0
 await Promise.all(Array.from({length:500},()=>limits.withCapacity('asr',async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,500));active--})))
 await limits.health()
 console.log(JSON.stringify({passed:true,users:500,admissionMs,modelStageMs:performance.now()-start,modelMs:500,peak,pending:limits.stats()}))
 assert.ok(admissionMs<3000,'500 admission checks must not stall')
 assert.ok(performance.now()-start<3000,'500 concurrent 500ms operations must not serialize on Sentinel')
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await limits.close();process.exit(process.exitCode||0)})
