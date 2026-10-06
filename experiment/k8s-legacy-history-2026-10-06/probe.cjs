const assert=require('node:assert/strict')
const {PostgresConfigStore}=require('/app/server/storage/remote.cjs')
const base='http://gateway:8787',phase=process.argv[2]||'baseline'
;(async()=>{
 const store=new PostgresConfigStore(process.env);await store.ready
 const name='legacy'+Date.now(),registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:'legacy-test-only',NT:name,Department:'Lab'})})
 assert.equal(registration.status,201);const account=await registration.json(),id=account.user.id,headers={authorization:'Bearer '+account.token,'content-type':'application/json'}
 const sessions=[{id:'preserve-me',title:'舊帳號既有紀錄',segments:[{id:'seg',sourceText:'This history must survive'}]}],results=[]
 try{
  const fixtures=[['array',sessions],['zero',{sessions,version:0}],['missing',{sessions,extra:'keep'}],['string',{sessions,version:'9'}],['negative',{sessions,version:-1}],['fraction',{sessions,version:1.5}]]
  for(const[kind,value]of fixtures){
   await store.put(id,'sessions',value)
   const responses=await Promise.all(Array.from({length:20},async()=>{const r=await fetch(base+'/api/data/sessions',{headers});return{status:r.status,body:await r.json()}}))
   if(phase==='baseline'){results.push({kind,status:responses[0].status,records:responses[0].body.sessions.length,version:responses[0].body.version});continue}
   const version=responses[0].body.version;assert.ok(version>=2**48&&Number.isSafeInteger(version));assert.ok(responses.every(r=>r.status===200&&r.body.version===version));for(const r of responses)assert.deepEqual(r.body.sessions,sessions)
   if(value.extra)assert.ok(responses.every(r=>r.body.extra==='keep'))
   const stale=await fetch(base+'/api/data/sessions',{method:'POST',headers,body:JSON.stringify({sessions:[],version:0})});assert.equal(stale.status,409)
   assert.deepEqual((await store.get(id,'sessions')).sessions,sessions)
   const positiveStale=await fetch(base+'/api/data/sessions',{method:'POST',headers,body:JSON.stringify({sessions:[],version:1})});assert.equal(positiveStale.status,409)
   const edited=[...sessions,{id:'new-record',title:'Saved after repair',segments:[]}]
   const edit=await fetch(base+'/api/data/sessions',{method:'POST',headers,body:JSON.stringify({sessions:edited,version})});assert.equal(edit.status,200)
   const after=await fetch(base+'/api/data/sessions',{headers}).then(r=>r.json());assert.equal(after.version,version+1);assert.deepEqual(after.sessions,edited)
   results.push({kind,concurrentReaders:20,preserved:true,version,staleStatus:stale.status,positiveStaleStatus:positiveStale.status,editStatus:edit.status})
  }
  for(const value of ['broken',{unexpected:'must not overwrite'}]){
   await store.put(id,'sessions',value)
   const read=await fetch(base+'/api/data/sessions',{headers})
   const write=await fetch(base+'/api/data/sessions',{method:'POST',headers,body:JSON.stringify({sessions:[],version:0})})
   if(phase==='fixed'){assert.equal(read.status,503);assert.equal(write.status,503);assert.deepEqual(await store.get(id,'sessions'),value)}
   results.push({kind:'corrupt',readStatus:read.status,writeStatus:write.status,unchanged:JSON.stringify(await store.get(id,'sessions'))===JSON.stringify(value)})
  }
  console.log(JSON.stringify({phase,results}))
 }finally{await store.pool.query('DELETE FROM s2t_config_records WHERE scope=$1',[id]);await store.pool.query('DELETE FROM s2t_users WHERE id=$1',[id]);await store.pool.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
