const assert=require('node:assert/strict')
const {PostgresConfigStore,MinioBlobStore}=require('/app/server/storage/remote.cjs')
const base='http://gateway:8787',phase=process.argv[2]||'baseline'
;(async()=>{
 const store=new PostgresConfigStore(process.env),blob=new MinioBlobStore(process.env);await Promise.all([store.ready,blob.ready])
 const name='legacyaudio'+Date.now(),r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:'legacy-audio-test-only',NT:name,Department:'Lab'})});assert.equal(r.status,201)
 const a=await r.json(),id=a.user.id,headers={authorization:'Bearer '+a.token,'content-type':'application/json'},key='legacy-wave',wav=Buffer.alloc(48044)
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
 const session={id:'legacy-session',title:'Keep referenced audio',audioKey:key,durationMs:1500,segments:[{id:'seg',startMs:0,endMs:1500,sourceText:'legacy speech',translatedText:'舊紀錄',status:'final',revision:1}]},results=[]
 try{
  for(const [kind,value,path,pending]of [['audit-array',[session],'/api/data/storage-audit',[]],['audit-corrupt','broken','/api/data/storage-audit',[]],['retry-array',[session],'/api/data/storage-retry',[{id:key,createdAt:'2000-01-01T00:00:00Z'}]]]){
   await blob.put(id,'audio/'+key,wav);await store.put(id,'sessions',value);await store.put(id,'audio-compensations',pending)
   const action=await fetch(base+path,{method:'POST',headers,body:'{}'}),audio=await fetch(base+'/api/data/audio/'+key,{headers})
   if(phase==='fixed'){assert.equal(action.status,kind==='audit-corrupt'?503:200);assert.equal(audio.status,200);assert.deepEqual(Buffer.from(await audio.arrayBuffer()),wav)}
   results.push({kind,actionStatus:action.status,audioStatus:audio.status})
  }
  if(phase==='fixed'){
   await store.put(id,'sessions',[{...session,processingState:'running',processingStage:'diarization',processingToken:'legacy-job'}])
   const queued=await fetch(base+'/api/data/diarization-jobs',{method:'POST',headers,body:JSON.stringify({sessionId:session.id,audioKey:key,processingToken:'legacy-job'})});assert.equal(queued.status,202)
   const job=(await queued.json()).job;let completed=false
   for(let i=0;i<60;i++){
    const current=await store.get(id,'sessions')
    if(current?.sessions?.[0]?.processingState==='completed'){assert.ok(Number.isSafeInteger(current.version)&&current.version>=2**48);completed=true;break}
    await new Promise(r=>setTimeout(r,500))
   }
   assert.ok(completed,'legacy-array background job must complete')
   results.push({kind:'background-job',queuedStatus:202,completed:true})
  }
  console.log(JSON.stringify({phase,results}))
 }finally{await blob.remove(id,'audio/'+key);await store.pool.query('DELETE FROM s2t_config_records WHERE scope=$1',[id]);await store.pool.query('DELETE FROM s2t_users WHERE id=$1',[id]);await store.pool.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
