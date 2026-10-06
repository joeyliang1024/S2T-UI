const assert=require('node:assert/strict'),{mkdtemp,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path')
const {LocalConfigStore}=require('../../server/storage/local.cjs'),{loadSessionSnapshot}=require('../../server/session-snapshot.cjs')
;(async()=>{
 const root=await mkdtemp(join(tmpdir(),'s2t-legacy-'))
 try{
  const store=new LocalConfigStore(root),other=new LocalConfigStore(root),sessions=[{id:'legacy-record',title:'Keep this',segments:[{sourceText:'must survive'}]}]
  assert.deepEqual(await loadSessionSnapshot(store,'new'),{sessions:[],version:0})
  for(const value of [sessions,{sessions},{sessions,version:0},{sessions,version:'4',extra:'preserved'},{sessions,version:-1},{sessions,version:1.5}]){
   await store.put('user','sessions',value)
   const reads=await Promise.all(Array.from({length:20},(_,i)=>loadSessionSnapshot(i%2?store:other,'user')))
   const version=reads[0].version;assert.ok(version>=2**48&&Number.isSafeInteger(version));assert.ok(reads.every(v=>v.version===version));assert.deepEqual(reads[0].sessions,sessions)
   if(value.extra)assert.equal(reads[0].extra,value.extra)
   assert.equal(await other.compareAndSwap('user','sessions',0,{sessions:[],version:1}),false)
   assert.equal(await other.compareAndSwap('user','sessions',1,{sessions:[],version:2}),false)
   assert.equal(await other.compareAndSwap('user','sessions',version,{sessions,version:version+1}),true)
   assert.equal((await loadSessionSnapshot(store,'user')).version,version+1)
  }
  for(const value of ['broken',{unexpected:'do not erase'}]){
   await store.put('user','sessions',value)
   await assert.rejects(loadSessionSnapshot(store,'user'),e=>e.status===503)
   assert.deepEqual(await store.get('user','sessions'),value)
  }
  console.log('PASS new and modern records, atomic legacy migration, concurrent readers, stale-zero fencing, unknown fields and corrupt-data preservation')
 }finally{await rm(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
