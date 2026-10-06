const fs=require('node:fs'),assert=require('node:assert/strict'),{promisify}=require('node:util'),{gzip}=require('node:zlib')
const zip=promisify(gzip),users=JSON.parse(fs.readFileSync('/tmp/stress-users.json')),base='http://gateway:8787'
const segments=Array.from({length:240},(_,i)=>({id:'seg-'+i,startMs:i*10000,endMs:(i+1)*10000,sourceText:'這是一段模擬會議的字幕，用來測試大量歷史紀錄同步時會不會影響編輯、搜尋及資料保存。'.repeat(2),translatedText:('Simulated transcript for history synchronization, editing, search, and reliable persistence. '+i+' ').repeat(2),speaker:'SPEAKER_01',status:'final',revision:1}))
const added=Array.from({length:40},(_,i)=>({id:'large-fixture-'+i,title:'Simulated meeting '+i,createdAt:'2026-10-06T00:00:00Z',durationMs:2400000,source:'microphone',transcript:segments.map(s=>s.sourceText+'\n'+s.translatedText).join('\n'),audioKey:'',segments,processingState:'completed'}))
const headers=u=>({authorization:'Bearer '+u.token,'content-type':'application/json'})
async function load(u){const r=await fetch(base+'/api/data/sessions',{headers:headers(u),signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return r.json()}
async function save(u,sessions,version){const raw=JSON.stringify({sessions,version}),body=await zip(raw),t=Date.now();const r=await fetch(base+'/api/data/sessions',{method:'POST',headers:{...headers(u),'content-encoding':'gzip'},body,signal:AbortSignal.timeout(30000)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return{version:result.version,rawBytes:Buffer.byteLength(raw),wireBytes:body.length,durationMs:Date.now()-t}}
;(async()=>{
 const results=[],backups={},start=Date.now();let next=0
 await Promise.all(Array.from({length:4},async()=>{while(next<users.length){const i=next++,u=users[i];let original
  try{
   original=await load(u);backups[i]=original.sessions;fs.writeFileSync('/tmp/large-history-backups.json',JSON.stringify(backups),{mode:0o600})
   const write=await save(u,[...original.sessions,...added],original.version)
   const readStart=Date.now(),loaded=await load(u);assert.deepEqual(loaded.sessions,[...original.sessions,...added])
   results[i]={i,ok:true,...write,readDurationMs:Date.now()-readStart}
  }catch(e){results[i]={i,ok:false,error:e.message}}
  finally{if(original){try{const latest=await load(u);await save(u,original.sessions,latest.version);results[i].restored=true}catch(e){results[i].restored=false;results[i].restoreError=e.message}}}
 }}))
 console.log(JSON.stringify({phase:'100-users-large-history',users:100,clientConcurrency:4,passed:results.filter(x=>x.ok&&x.restored).length,elapsedMs:Date.now()-start,results}))
 if(results.some(x=>!x.ok||!x.restored))process.exitCode=1
})().catch(e=>{console.error(e);process.exitCode=1})
