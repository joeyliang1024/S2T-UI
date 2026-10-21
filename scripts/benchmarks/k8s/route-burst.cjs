// Finite diagnostic bursts, not sustained capacity acceptance.
const jwt=require('jsonwebtoken'),{randomUUID}=require('node:crypto'),{Agent}=require('undici')
const {writeFile}=require('node:fs/promises')
const delay=ms=>new Promise(r=>setTimeout(r,ms)), run=randomUUID(), base='http://gateway:8787'
const {cachedLookup}=require('/app/server/dns-lookup.cjs')
const agent=new Agent({connections:1024,keepAliveTimeout:10000,connect:{lookup:cachedLookup}}), controller=new AbortController()
const users=Array.from({length:500},(_,i)=>jwt.sign({sub:`perf-${i}`,jti:`${run}-${i}`},process.env.PERF_AUTH_SECRET,{expiresIn:'30m'}))
const bytes=Buffer.alloc(64044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(64000,40)
let phase='idle', polling=false
const health=[], results=[]
const poll=async()=>{if(polling)return;polling=true;await Promise.all((process.env.PERF_POD_IPS||'').split(',').filter(Boolean).map(async ip=>{const start=performance.now();try{const r=await fetch(`http://${ip}:8787/readyz`,{signal:AbortSignal.timeout(1500)});health.push({phase,ip,at:new Date().toISOString(),ms:performance.now()-start,status:r.status,timing:r.headers.get('server-timing'),body:await r.text()})}catch(e){health.push({phase,ip,ms:performance.now()-start,error:e.message})}}));polling=false}
const request=async(kind,i)=>{
 const path=kind==='asr'?'/api/transcriptions':kind==='translation'?'/api/translations':`/api/data/recordings/diagnostic-${run}-${i}/chunks/0`
 const start=performance.now()
 try{
  const r=await fetch(base+path,{method:kind==='upload'?'PUT':'POST',dispatcher:agent,headers:{authorization:`Bearer ${users[i]}`,'content-type':kind==='translation'?'application/json':'audio/wav','x-s2t-idempotency-key':`${run}-${kind}-${i}`,'x-s2t-start-sample':'0','x-s2t-sample-rate':'16000'},body:kind==='translation'?JSON.stringify({text:'Finite diagnostic burst.',targetLanguage:'zh-TW'}):kind==='upload'?bytes.subarray(44):bytes,signal:AbortSignal.timeout(8000)})
  const body=await r.text();return{kind,status:r.status,ms:performance.now()-start,timing:r.headers.get('server-timing'),...(!r.ok?{body:body.slice(0,200)}:{})}
 }catch(e){return{kind,ms:performance.now()-start,error:e.message,cause:e.cause?.code}}
}
;(async()=>{
 const timer=setInterval(()=>void poll(),500)
 try{
  await poll()
  for(const stage of ['asr','translation','upload']){
   phase=stage;const start=performance.now(),rows=await Promise.all(users.map((_,i)=>request(stage,i)))
   const durations=rows.map(x=>x.ms).sort((a,b)=>a-b);const summary={stage,wallMs:performance.now()-start,success:rows.filter(x=>x.status>=200&&x.status<300).length,p95Ms:durations[474],p99Ms:durations[494],errors:rows.filter(x=>!x.status||x.status>=400).slice(0,10)}
   results.push({summary,rows});console.log(JSON.stringify(summary));phase='recovery';await delay(8000)
  }
 }finally{clearInterval(timer)}
 await writeFile('/tmp/route-burst-report.json',JSON.stringify({run,results,health},null,2));console.log(JSON.stringify({event:'diagnostic_completed',readinessFailures:health.filter(x=>x.status!==200),report:'/tmp/route-burst-report.json'}))
 await agent.close()
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>process.exit(process.exitCode||0))
