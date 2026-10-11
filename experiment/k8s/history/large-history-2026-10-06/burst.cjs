const fs=require('node:fs'),assert=require('node:assert/strict'),{promisify}=require('node:util'),{gzip}=require('node:zlib')
const zip=promisify(gzip),users=JSON.parse(fs.readFileSync('/tmp/stress-users.json')),base='http://gateway:8787'
const segments=Array.from({length:240},(_,i)=>({id:'seg-'+i,startMs:i*10000,endMs:(i+1)*10000,sourceText:'這是一段模擬會議的字幕，用來測試大量歷史紀錄同步時會不會影響編輯、搜尋及資料保存。'.repeat(2),translatedText:('Simulated transcript for history synchronization, editing, search, and reliable persistence. '+i+' ').repeat(2),speaker:'SPEAKER_01',status:'final',revision:1}))
const added=Array.from({length:40},(_,i)=>({id:'large-fixture-'+i,title:'Simulated meeting '+i,createdAt:'2026-10-06T00:00:00Z',durationMs:2400000,source:'microphone',transcript:segments.map(s=>s.sourceText+'\n'+s.translatedText).join('\n'),audioKey:'',segments,processingState:'completed'}))
const headers=u=>({authorization:'Bearer '+u.token,'content-type':'application/json'})
async function load(u){const r=await fetch(base+'/api/data/sessions',{headers:headers(u),signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return r.json()}
async function save(u,sessions,version){const raw=JSON.stringify({sessions,version}),body=await zip(raw),t=Date.now();const r=await fetch(base+'/api/data/sessions',{method:'POST',headers:{...headers(u),'content-encoding':'gzip'},body,signal:AbortSignal.timeout(30000)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return{version:result.version,rawBytes:Buffer.byteLength(raw),wireBytes:body.length,durationMs:Date.now()-t}}

;(async()=>{
 const prepared=[],results=[],start=Date.now();let next=0
 await Promise.all(Array.from({length:4},async()=>{while(next<users.length){const i=next++,u=users[i],original=await load(u),raw=JSON.stringify({sessions:[...original.sessions,...added],version:original.version});prepared[i]={u,original,body:await zip(raw),rawBytes:Buffer.byteLength(raw)}}}))
 const burstStart=Date.now()
 await Promise.all(prepared.map(async(p,i)=>{
  const t=Date.now()
  try{const r=await fetch(base+'/api/data/sessions',{method:'POST',headers:{...headers(p.u),'content-encoding':'gzip'},body:p.body,signal:AbortSignal.timeout(30000)});const v=await r.json();results[i]={i,status:r.status,ok:r.status===200,version:v.version,rawBytes:p.rawBytes,wireBytes:p.body.length,durationMs:Date.now()-t,error:v.error}}catch(e){results[i]={i,ok:false,error:e.message}}
 }))
 const burstMs=Date.now()-burstStart;next=0
 await Promise.all(Array.from({length:4},async()=>{while(next<users.length){const i=next++,p=prepared[i];try{const current=await load(p.u);if(results[i].ok)assert.deepEqual(current.sessions,[...p.original.sessions,...added]);await save(p.u,p.original.sessions,current.version);results[i].restored=true}catch(e){results[i].restored=false;results[i].restoreError=e.message}}}))
 console.log(JSON.stringify({phase:'100-simultaneous-large-history',users:100,clientConcurrency:100,passed:results.filter(x=>x.ok&&x.restored).length,burstMs,elapsedMs:Date.now()-start,results}))
 if(results.some(x=>!x.ok||!x.restored))process.exitCode=1
})().catch(e=>{console.error(e);process.exitCode=1})
