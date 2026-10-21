const assert=require('node:assert/strict')
const {createCachedLookup}=require('../../server/dns-lookup.cjs')
;(async()=>{
 let calls=0,clock=0,fail=false,records=[{address:'10.0.0.1',family:4},{address:'10.0.0.2',family:4}]
 const lookup=createCachedLookup({now:()=>clock,maximum:2,resolve:(_host,_options,cb)=>{calls++;setTimeout(()=>cb(fail?Object.assign(new Error('DNS unavailable'),{code:'EAI_AGAIN'}):null,records),5)}})
 const one=(host='model',options={})=>new Promise((resolve,reject)=>lookup(host,options,(error,address,family)=>error?reject(error):resolve({address,family})))
 const burst=await Promise.all(Array.from({length:500},()=>one()))
 assert.equal(calls,1,'500 connections to the same hostname coalesce one lookup')
 assert.equal(burst.filter(x=>x.address==='10.0.0.1').length,250)
 assert.equal((await one('model',{all:true})).address.length,2,'Node autoSelectFamily gets all records')
 await one('model',{family:6}); assert.equal(calls,2,'family-specific DNS queries remain separate')
 clock=5001;records=[{address:'10.0.0.3',family:4}]
 assert.equal((await one()).address,'10.0.0.3','expired records re-resolve after failover')
 await one('other');await one('third');const before=calls;await one();assert.equal(calls,before+1,'cache stays bounded')
 records=[{address:'10.0.0.4',family:4},{address:'::1',family:6}]
 const mixed=await Promise.all(Array.from({length:4},()=>one('mixed')))
 assert.ok(mixed.every(x=>x.family===4),'cache preserves resolver family preference')
 fail=true;await assert.rejects(one('broken'),{code:'EAI_AGAIN'});fail=false;await one('broken')
 console.log('PASS bounded/coalesced DNS: 500 sockets, address rotation, all/family contract, TTL failover and uncached resolver errors')
})().catch(e=>{console.error(e);process.exitCode=1})
