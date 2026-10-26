const assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const code=buildSync({entryPoints:['frontend/src/features/sessions/services/sync-coordinator.ts'],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {createSessionSyncCoordinator}=m.exports
const row=(title,token='old')=>({id:'a',title,createdAt:'2026-10-14',durationMs:0,source:'fixture',transcript:'',segments:[],audioKey:'a',audioUnavailable:false,processingState:'completed',processingToken:token})
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(){
 const f={server:[row('base')],version:1,events:[],locals:[],errors:[],calls:[],timers:new Map(),disk:undefined,opens:0,acks:0,closed:0};let id=0
 f.remote={load:async()=>({sessions:f.server,version:f.version}),save:async(rows,version)=>{f.calls.push({rows,version});if(version!==f.version)throw Error('HTTP 409');f.server=rows;return ++f.version}}
 f.outbox={read:async()=>f.disk,save:async value=>{f.disk=structuredClone(value)},acknowledge:async rows=>{f.acks++;if(JSON.stringify(f.disk?.local)===JSON.stringify(rows)){f.disk=undefined;return true}return false},close:async()=>{f.closed++}}
 f.sync=createSessionSyncCoordinator({remote:f.remote,openOutbox:()=>{f.opens++;return f.open?f.open():f.outbox},clock:{setTimeout:fn=>{f.timers.set(++id,fn);return id},clearTimeout:id=>f.timers.delete(id)},isActive:()=>f.active!==false,recover:rows=>rows,onLocal:rows=>f.locals.push(rows),onState:state=>f.events.push(state),onError:error=>f.errors.push(error)})
 f.start=async()=>{await f.sync.restoreCheckpoint();f.sync.initialize({baseline:f.server,local:f.server,version:f.version})}
 f.fire=async()=>{const [id,fn]=f.timers.entries().next().value;f.timers.delete(id);fn();await tick()}
 return f
}
;(async()=>{
 // The server committed even though its ACK was lost.
 const lost=fixture();await lost.start();let lose=true;const save=lost.remote.save
 lost.remote.save=async(...args)=>{const version=await save(...args);if(lose){lose=false;throw Error('ACK lost')}return version}
 lost.sync.enqueue([row('edit')]);await tick();assert.equal(lost.sync.getState().status,'paused');assert.equal(lost.disk.local[0].title,'edit')
 await lost.sync.retry();assert.equal(lost.server[0].title,'edit');assert.equal(lost.server.length,1);assert.equal(lost.sync.getState().status,'ready');assert.equal(lost.disk,undefined);await lost.sync.close()
 // Choosing local only authorizes overwriting the remote revision the user saw.
 const conflict=fixture();await conflict.start();conflict.server=[row('remote')];conflict.version=2
 conflict.sync.enqueue([row('local')]);await tick();assert.equal(conflict.sync.getState().conflicts.length,1)
 conflict.server=[row('unseen remote')];conflict.version=3
 await conflict.sync.resolve('a','local');assert.equal(conflict.sync.getState().conflicts[0].remote.title,'unseen remote');assert.equal(conflict.server[0].title,'unseen remote')
 await conflict.sync.resolve('a','local');assert.equal(conflict.server[0].title,'local');assert.deepEqual(conflict.sync.getState().conflicts,[]);await conflict.sync.close()
 // Edits made while a user's choice is checkpointing must survive.
 const editing=fixture();await editing.start();editing.server=[row('remote')];editing.version=2;editing.sync.enqueue([row('local')]);await tick()
 const gate=deferred();let held=false;const write=editing.outbox.save
 editing.outbox.save=async value=>{if(!held&&value.baseline[0]?.title==='remote'){held=true;await gate.promise}await write(value)}
 const choosing=editing.sync.resolve('a','local');await tick();editing.sync.record([row('latest local edit')]);gate.resolve();await choosing
 assert.equal(editing.server[0].title,'latest local edit');await editing.sync.close()
 // An ACK for a previous capture cannot clean the next continuation's source.
 const oldAck=fixture();await oldAck.start();const ackGate=deferred();const oldSave=oldAck.remote.save;oldAck.remote.save=async(...args)=>{await ackGate.promise;return oldSave(...args)}
 oldAck.sync.enqueue([row('first')]);await tick();let cleaned=0;oldAck.sync.registerCleanup('a','a',async()=>{cleaned++},'new')
 ackGate.resolve();await tick();assert.equal(cleaned,0)
 oldAck.sync.enqueue([row('next','new')]);await tick();assert.equal(cleaned,1);await oldAck.sync.close()
 // An old cleanup that finishes late must not delete its replacement from the registry.
 const replaced=fixture();await replaced.start();const cleanupGate=deferred();let oldClean=0,newClean=0
 replaced.sync.registerCleanup('a','a',async()=>{oldClean++;await cleanupGate.promise},'old');replaced.sync.enqueue([row('first')]);await tick();assert.equal(oldClean,1)
 replaced.sync.registerCleanup('a','a',async()=>{newClean++},'new');replaced.sync.enqueue([row('next','new')]);cleanupGate.resolve();await tick();await tick();assert.equal(newClean,1);await replaced.sync.close()
 // Cleanup failures retry without waiting for a user's next edit.
 const cleanup=fixture();await cleanup.start();let attempts=0;cleanup.sync.registerCleanup('a','a',async()=>{if(++attempts===1)throw Error('temporary cleanup outage')},'old');cleanup.sync.enqueue([row('edit')]);await tick();assert.equal(attempts,1);await cleanup.fire();assert.equal(attempts,2);await cleanup.sync.close()
 // Closing an account suppresses the old ACK, UI notifications and cleanup; its checkpoint remains.
 const closed=fixture();await closed.start();const late=deferred();closed.remote.save=async()=>late.promise;let forbidden=0;closed.sync.registerCleanup('a','a',async()=>{forbidden++},'old');closed.sync.enqueue([row('edit')]);await tick();await closed.sync.close();const count=closed.events.length
 late.resolve(2);await tick();assert.equal(closed.events.length,count);assert.equal(forbidden,0);assert.equal(closed.disk.local[0].title,'edit');assert.equal(closed.timers.size,0)
 // A failed initial open can be retried, without saving before the outbox exists.
 const reopen=fixture();let fail=true;reopen.open=()=>{if(fail){fail=false;throw Error('temporary IndexedDB outage')}return reopen.outbox}
 await assert.rejects(reopen.sync.restoreCheckpoint(),/temporary/);reopen.sync.initialize({baseline:reopen.server,local:[row('offline edit')],version:1});assert.equal(reopen.calls.length,0)
 await reopen.sync.retry();assert.equal(reopen.opens,2);assert.equal(reopen.server[0].title,'offline edit');await reopen.sync.close()
 // An unread disk checkpoint and additional memory edits are retained independently; repeated retry cannot overwrite the disk.
 const unread=fixture();unread.disk={baseline:[row('base')],local:[row('disk edit')]};let unavailable=true;unread.outbox.read=async()=>{if(unavailable){unavailable=false;throw Error('unavailable')}return unread.disk}
 await assert.rejects(unread.sync.restoreCheckpoint());unread.sync.initialize({baseline:unread.server,local:[row('memory edit')],version:1});await unread.sync.retry();await unread.sync.retry()
 assert.equal(unread.calls.length,0);assert.equal(unread.disk.local[0].title,'disk edit');assert.equal(unread.sync.getState().pending[0].title,'memory edit');await unread.sync.close()
 // A recovered cleanup runs even when the user makes no subsequent edit.
 const recoveredCleanup=fixture();await recoveredCleanup.start();let recoveredCleaned=0
 recoveredCleanup.sync.registerCleanup('a','a',async()=>{recoveredCleaned++},'old')
 await recoveredCleanup.fire();assert.equal(recoveredCleaned,1);await recoveredCleanup.sync.close()
 console.log('PASS coordinator: lost ACK, unseen revision conflicts, edits during choices, capture-token/identity cleanup fences, automatic cleanup retry, closed-owner fencing and safe outbox reopen')
})().catch(error=>{console.error(error);process.exitCode=1})
