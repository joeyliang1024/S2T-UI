const assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const bundled=buildSync({entryPoints:['src/renderer/src/features/sessions/domain/storage-state.ts'],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports',bundled)(m,m.exports)
const {sessionStorageStatesForSnapshot:states,displayedSessionStorageState:display}=m.exports
const mergeCode=buildSync({entryPoints:['src/renderer/src/features/sessions/domain/session-merge.ts'],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text
const mergeModule={exports:{}};new Function('module','exports','require',mergeCode)(mergeModule,mergeModule.exports,require)
const a={id:'a',createdAt:'2026-10-14',title:'A',processingState:'completed'},b={id:'b',createdAt:'2026-10-14',title:'B',processingState:'completed'}
assert.deepEqual(states([{...a,title:'edited'},b],[a,b],{a:'both',b:'remote'}),{a:'pending',b:'remote'})
assert.equal(states([{...a,processingState:'running'}],[{...a,processingState:'running'}],{a:'both'}).a,'pending')
for(const value of ['both','remote','local','pending'])assert.equal(display(value,true),'pending')
const syncCode=buildSync({entryPoints:['src/renderer/src/features/sessions/services/sync-coordinator.ts'],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text
const syncModule={exports:{}};new Function('module','exports','require',syncCode)(syncModule,syncModule.exports,require)
const {createSessionSyncCoordinator}=syncModule.exports
;(async()=>{
 let badges={a:'both',b:'both'},calls=[],history=[]
 const ctx={remote:{save:async snapshot=>new Promise((resolve,reject)=>calls.push({snapshot,resolve,reject})),load:async()=>{throw Error('unexpected load')}},openOutbox:()=>({read:async()=>undefined,save:async()=>{},acknowledge:async()=>true,close:async()=>{}}),clock:{setTimeout:()=>1,clearTimeout:()=>{}},isActive:()=>true,recover:rows=>rows,onLocal:()=>{},onState:state=>{badges=states(state.local,state.baseline,state.acknowledged?Object.fromEntries(state.local.map(row=>[row.id,'both'])):badges);history.push({...badges})},onError:()=>{}}
 const coordinator=createSessionSyncCoordinator(ctx)
 await coordinator.restoreCheckpoint();coordinator.initialize({baseline:[a,b],local:[a,b],version:1})
 const enqueue=coordinator.enqueue
 const tick=()=>new Promise(r=>setImmediate(r))
 enqueue([{...a,title:'first'},b]);await tick();assert.deepEqual(badges,{a:'pending',b:'both'})
 enqueue([{...a,title:'second'},b]);calls[0].resolve(2);await tick()
 assert.equal(calls.length,2);assert.deepEqual(badges,{a:'pending',b:'both'},'intermediate acknowledgement cannot show both')
 calls[1].resolve(3);await tick();assert.deepEqual(badges,{a:'both',b:'both'})
 enqueue([{...a,title:'second',processingState:'running'},b]);await tick();calls[2].resolve(4);await tick();assert.equal(badges.a,'pending','partial running writes remain pending')
 enqueue([{...a,title:'final'},b]);await tick();calls[3].resolve(5);await tick();assert.deepEqual(badges,{a:'both',b:'both'})
 enqueue([{...a,title:'offline'},b]);await tick();calls[4].reject(Error('mock outage'));await tick();assert.deepEqual(badges,{a:'pending',b:'both'},'outage only marks dirty records')
 assert.ok(history.every(x=>x.b==='both'))
 // Exercise the production queue across multiple CAS failures and edits made
 // while the first request is in flight, rather than only the merge helper.
 const c={id:'c',createdAt:'2026-10-14',title:'C'},d={id:'d',createdAt:'2026-10-14',title:'D'}
 coordinator.initialize({baseline:[a,b],local:[a,b],version:1})
 let loads=0
 ctx.remote.load=async()=>({sessions:loads++===0?[a,b,c]:[a,b,c,d],version:loads+1})
 enqueue([b]);await tick();enqueue([{...b,title:'new local edit'}])
 calls[5].reject(Error('HTTP 409'));await tick();assert.equal(calls.length,7)
 calls[6].reject(Error('HTTP 409'));await tick();assert.equal(calls.length,8)
 assert.deepEqual(calls[7].snapshot.map(x=>x.id),['b','c','d'])
 assert.equal(calls[7].snapshot[0].title,'new local edit','second conflict must preserve newest local edits')
 calls[7].resolve(4);await tick()
 assert.equal(coordinator.getState().baseline.some(x=>x.id==='a'),false,'deleted record never resurrects')
 assert.equal(coordinator.getState().pending,null)

 await coordinator.close()
 console.log('PASS production save queue: intermediate saves remain pending, running progress stable, completed final commit acknowledged, unrelated records preserved, failures remain pending; no API calls')
})().catch(e=>{console.error(e);process.exitCode=1})
