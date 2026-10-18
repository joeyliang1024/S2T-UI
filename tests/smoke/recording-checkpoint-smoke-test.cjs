const assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const code=buildSync({entryPoints:['src/renderer/src/features/capture/recording/checkpoint.ts'],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {startRecordingCheckpoints}=m.exports
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
;(async()=>{
 let tick,release,revision=1,reads=0,cleared=0;const local=[],remote=[],errors=[]
 const stop=startRecordingCheckpoints({read:()=>{reads++;return{id:'capture',segments:[],elapsedMs:revision}},local:async value=>{local.push(value.elapsedMs)},remote:async value=>{remote.push(value.elapsedMs);if(remote.length===1)await new Promise(resolve=>{release=resolve})},onError:error=>errors.push(error),clock:{setInterval:callback=>{tick=callback;return 1},clearInterval:()=>{cleared++}}})
 await flush();assert.deepEqual(local,[1]);assert.deepEqual(remote,[1])
 for(revision=2;revision<=4;revision++){tick();await flush()}
 assert.deepEqual(local,[1,2,3,4],'local cadence continues during stalled remote writes');assert.deepEqual(remote,[1],'one inflight remote write bounds pending work')
 release();await flush();revision=5;tick();await flush();assert.deepEqual(remote,[1,5],'next checkpoint reads latest snapshot instead of replaying stale backlog')
 stop();revision=6;tick();await flush();assert.equal(reads,5);assert.equal(cleared,1);assert.deepEqual(errors,[])
 let reject;const late=[];const close=startRecordingCheckpoints({read:()=>({id:'capture'}),local:()=>new Promise((_resolve,no)=>{reject=no}),remote:async()=>{},onError:error=>late.push(error),clock:{setInterval:()=>1,clearInterval:()=>{}}})
 await flush();close();reject(Error('late previous capture failure'));await flush();assert.deepEqual(late,[],'stopped checkpoint cannot publish errors into another capture')
 let active=true,sent=0;const cancelBeforeWrite=startRecordingCheckpoints({read:()=>({id:'capture'}),local:async()=>{sent++},remote:async()=>{sent++},isActive:()=>active,onError:()=>{},clock:{setInterval:()=>1,clearInterval:()=>{}}});active=false;await flush();cancelBeforeWrite();assert.equal(sent,0,'account epoch change before queued work cannot send old capture data')
 console.log('PASS fixed checkpoint cadence, fresh snapshots, independent local/remote writers, bounded inflight work and stopped-owner error fencing')
})().catch(error=>{console.error(error);process.exitCode=1})
