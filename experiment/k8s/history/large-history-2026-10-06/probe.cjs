const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto'),zlib=require('node:zlib')
const base='http://gateway:8787',mode=process.argv[2]||'baseline',json=v=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)})
;(async()=>{
 const file='/tmp/large-history-user.json'
 let account
 if(fs.existsSync(file))account=JSON.parse(fs.readFileSync(file))
 else{const name='large'+Date.now();const r=await fetch(base+'/api/auth/register',json({username:name,password:'large-history-test-only',NT:name,Department:'LoadLab'}));assert.equal(r.status,201);account=await r.json();fs.writeFileSync(file,JSON.stringify(account),{mode:0o600})}
 const headers={authorization:'Bearer '+account.token,'content-type':'application/json'}
 const segments=Array.from({length:240},(_,i)=>({id:'seg-'+i,startMs:i*10000,endMs:(i+1)*10000,sourceText:'這是一段模擬會議的字幕，用來測試大量歷史紀錄同步時會不會影響編輯、搜尋及資料保存。'.repeat(2),translatedText:('Simulated transcript for history synchronization, editing, search, and reliable persistence. '+i+' ').repeat(2),speaker:'SPEAKER_01',status:'final',revision:1}))
 const sessions=Array.from({length:40},(_,i)=>({id:'history-'+i,title:'Simulated meeting '+i,createdAt:'2026-10-06T00:00:00Z',durationMs:2400000,source:'microphone',transcript:segments.map(s=>s.sourceText+'\n'+s.translatedText).join('\n'),audioKey:'',segments,processingState:'completed'}))
 const current=await fetch(base+'/api/data/sessions',{headers}).then(r=>r.json())
 const body=JSON.stringify({sessions,version:current.version}),raw=Buffer.from(body),start=Date.now()
 let output={phase:mode,records:40,segments:9600,bytes:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex')}
 try{
  const gzip=mode==='gzip';const wire=gzip?zlib.gzipSync(raw):raw
  const r=await fetch(base+'/api/data/sessions',{method:'POST',headers:{...headers,...(gzip?{'content-encoding':'gzip'}:{})},body:wire,signal:AbortSignal.timeout(30000)})
  output={...output,status:r.status,response:await r.json(),wireBytes:wire.length,durationMs:Date.now()-start}
  if(mode!=='baseline'){
   assert.equal(r.status,200)
   const loaded=await fetch(base+'/api/data/sessions',{headers}).then(r=>r.json());assert.deepEqual(loaded.sessions,sessions)
   const stale=await fetch(base+'/api/data/sessions',{...json({sessions:[],version:current.version}),headers});assert.equal(stale.status,409)
   output.roundTripPassed=true;output.staleCasRejected=true
  }
 }catch(e){output.error=e.message;if(mode!=='baseline')process.exitCode=1}
 console.log(JSON.stringify(output))
})().catch(e=>{console.error(e);process.exitCode=1})
