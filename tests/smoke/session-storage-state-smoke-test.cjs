const assert=require('node:assert/strict'),fs=require('node:fs'),{buildSync,transformSync}=require('esbuild')
const bundled=buildSync({entryPoints:['src/renderer/src/features/app/services/session-storage-state.ts'],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports',bundled)(m,m.exports)
const {sessionStorageStatesForSnapshot:states,displayedSessionStorageState:display}=m.exports
const a={id:'a',title:'A',processingState:'completed'},b={id:'b',title:'B',processingState:'completed'}
assert.deepEqual(states([{...a,title:'edited'},b],[a,b],{a:'both',b:'remote'}),{a:'pending',b:'remote'})
assert.equal(states([{...a,processingState:'running'}],[{...a,processingState:'running'}],{a:'both'}).a,'pending')
for(const value of ['both','remote','local','pending'])assert.equal(display(value,true),'pending')
const source=fs.readFileSync('src/renderer/src/features/app/hooks/useAppController.ts','utf8')
const fragment=transformSync(source.slice(source.indexOf('const enqueueRemoteSessionSave ='),source.indexOf('const retryRemoteSessionSync =')),{loader:'ts'}).code
;(async()=>{
 let badges={a:'both',b:'both'},calls=[],history=[]
 const ref=v=>({current:v}),syncing=ref(false),pending=ref(null),version=ref(1),committed=ref([a,b])
 const ctx={sessionStorageStatesForSnapshot:states,pendingRemoteSessionsRef:pending,remoteSessionsSyncingRef:syncing,remoteSessionsVersionRef:version,committedRemoteSessionsRef:committed,setRemoteSessionSyncState:()=>{},setSessionStorageStates:update=>{badges=update(badges);history.push({...badges})},remoteSessionStorage:{save:async snapshot=>new Promise((resolve,reject)=>calls.push({snapshot,resolve,reject}))},setSessions:()=>{},setStatus:()=>{},activeTranslate:x=>x,scheduleRemoteSessionRetry:()=>{},mergeSessions:()=>{throw Error('unexpected conflict')}}
 const enqueue=new Function(...Object.keys(ctx),fragment+';return enqueueRemoteSessionSave')(...Object.values(ctx))
 const tick=()=>new Promise(r=>setImmediate(r))
 enqueue([{...a,title:'first'},b]);assert.deepEqual(badges,{a:'pending',b:'both'})
 enqueue([{...a,title:'second'},b]);calls[0].resolve(2);await tick()
 assert.equal(calls.length,2);assert.deepEqual(badges,{a:'pending',b:'both'},'intermediate acknowledgement cannot show both')
 calls[1].resolve(3);await tick();assert.deepEqual(badges,{a:'both',b:'both'})
 enqueue([{...a,title:'second',processingState:'running'},b]);calls[2].resolve(4);await tick();assert.equal(badges.a,'pending','partial running writes remain pending')
 enqueue([{...a,title:'final'},b]);calls[3].resolve(5);await tick();assert.deepEqual(badges,{a:'both',b:'both'})
 enqueue([{...a,title:'offline'},b]);calls[4].reject(Error('mock outage'));await tick();assert.deepEqual(badges,{a:'pending',b:'both'},'outage only marks dirty records')
 assert.ok(history.every(x=>x.b==='both'))
 console.log('PASS production save queue: intermediate saves remain pending, running progress stable, completed final commit acknowledged, unrelated records preserved, failures remain pending; no API calls')
})().catch(e=>{console.error(e);process.exitCode=1})
