const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {createSharedLimits}=require('/app/server/shared-limits.cjs')
;(async()=>{
 assert.ok(!Object.keys(process.env).some(key=>key.startsWith('S2T_REDIS_')),'Pod must have no old application Redis names')
 const env={S2T_KUBERNETES_MODE:'true',REDIS_SENTINEL_NODES:process.env.REDIS_SENTINEL_NODES.split(',').map(v=>v.replace(/:26379$/,'')).join(','),REDIS_SERVICE_NAME:process.env.REDIS_SERVICE_NAME,REDIS_SENTINEL_USERNAME:process.env.REDIS_SENTINEL_USERNAME||'default',REDIS_PASSWARD:process.env.REDIS_PASSWARD,REDIS_SENTINEL_PASSWARD:process.env.REDIS_SENTINEL_PASSWARD,S2T_ASR_MAX_INFLIGHT:'2'}
 const limiter=createSharedLimits(env,{asr:2}),identity=randomUUID();let calls=0
 try{await limiter.ready;await limiter.health();assert.equal((await limiter.accept(identity,'asr')).accepted,true);assert.equal((await limiter.accept(identity,'asr')).accepted,true);assert.equal((await limiter.accept(identity,'asr')).accepted,false)
 await Promise.all(Array.from({length:6},()=>limiter.withCapacity('asr',async()=>{calls++;await new Promise(r=>setTimeout(r,20))})));assert.equal(calls,6)
 console.log(JSON.stringify({passed:true,oldNamesPresent:false,sentinelUsername:'default',portOmittedDefaultsTo:26379,modelExecutions:calls}))
 }finally{await limiter.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
