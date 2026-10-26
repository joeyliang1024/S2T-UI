const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: "export * from './frontend/src/features/sessions/services/recover-recordings'; export * from './frontend/src/features/capture/recording/recovery-manifest';", resolveDir: process.cwd(), loader: 'ts' }, bundle:true,format:'cjs',platform:'node',write:false }).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const { recoverRecordings, validateRecoveryEntry }=m.exports
const segment=(id,start,end)=>({id,revision:1,status:'final',startMs:start,endMs:end,sourceText:id})
const make=(id,extra={})=>({version:1,ownerId:'owner-a',recordingId:'pcm-'+id,draft:{id,startedAt:'2026-10-14T00:00:00Z',updatedAt:'2026-10-14T00:00:01Z',captureState:'paused',source:'fixture',elapsedMs:6000,sampleRate:16000,opfsRecordingId:'pcm-'+id,segments:[segment(id,0,1000)]},...extra})
function deps(){const uploads=[],cleanups=[],ack=[],errors=[],targets=[];return{uploads,cleanups,ack,errors,targets,readAudio:async()=>new Blob([new ArrayBuffer(32044)]),saveAudio:async key=>uploads.push(key),hasAudio:async()=>true,acknowledge:async(source,target)=>{ack.push(source.draft.id);targets.push(target)},registerCleanup:(...value)=>cleanups.push(value),title:draft=>draft.id,sourceLabel:draft=>draft.source,isActive:()=>true,onError:error=>errors.push(error)}}
;(async()=>{
 const a=make('one'), b=make('two'), d=deps()
 const recovered=await recoverRecordings({manifests:[a,b],legacyDraft:a.draft,remoteSessions:[]},d)
 assert.deepEqual(recovered.map(entry=>entry.id),['recovery-live-one','recovery-live-two']);assert.equal(d.uploads.length,2);assert.equal(d.ack.length,0,'audio upload is not metadata ACK');assert.equal(recovered[0].durationMs,1000)
 await d.cleanups[0][2]();assert.deepEqual(d.ack,['one'],'only explicit commit cleanup acknowledges source');assert.deepEqual(d.targets[0],{sessionId:'recovery-live-one',audioKey:'recovery-live-one',processingToken:undefined})
 const target={sessionId:'existing',audioKey:'existing.wav',processingToken:'new-token'}, manifest=make('tail',{target,captureOffsetMs:5000})
 manifest.draft.segments=[segment('old',0,1000),segment('tail',5000,6000)]
 const old={id:'existing',audioKey:'existing.wav',processingToken:'old-token',audioUnavailable:false,processingState:'completed'}, tail=deps()
 const restored=await recoverRecordings({manifests:[manifest],remoteSessions:[old]},tail)
 assert.equal(restored.length,1,'old continuation metadata cannot acknowledge a new capture');assert.deepEqual(restored[0].segments.map(s=>[s.id,s.startMs,s.endMs]),[['tail',0,1000]]);assert.equal(old.processingToken,'old-token')
 const committed=deps(), rows=await recoverRecordings({manifests:[manifest],remoteSessions:[{...old,processingToken:'new-token',processingState:'running',processingStage:'diarization'}]},committed)
 assert.deepEqual(rows,[]);assert.equal(committed.uploads.length,0);assert.equal(committed.cleanups[0][0],'existing','committed running record prevents duplicate recovery while cleanup gate waits')
 await committed.cleanups[0][2]();assert.deepEqual(committed.targets[0],target,'reload cleanup carries the committed target and token')
 const saving=deps();assert.equal((await recoverRecordings({manifests:[manifest],remoteSessions:[{...old,processingToken:'new-token',processingState:'running',processingStage:'saving'}]},saving)).length,1,'intermediate metadata cannot acknowledge capture audio')
 const failed=deps();failed.readAudio=async source=>{if(source.draft.id==='one')throw Error('source damaged');return new Blob([new ArrayBuffer(32044)])}
 const partial=await recoverRecordings({manifests:[a,b],remoteSessions:[]},failed);assert.equal(partial.length,2);assert.equal(partial[0].audioUnavailable,true);assert.equal(partial[1].audioUnavailable,false);assert.equal(failed.errors.length,1);assert.equal(failed.ack.length,0)
 const canceled=deps();let active=true;canceled.isActive=()=>active;canceled.readAudio=async()=>{active=false;return new Blob([new ArrayBuffer(32044)])}
 assert.deepEqual(await recoverRecordings({manifests:[a,b],remoteSessions:[]},canceled),[]);assert.equal(canceled.uploads.length,0)
 assert.equal(validateRecoveryEntry(manifest,manifest.recordingId),manifest)
 assert.throws(()=>validateRecoveryEntry({...manifest,target:{...target,processingToken:undefined}},manifest.recordingId),/target/)
 console.log('PASS multiple recovery sources, legacy deduplication, precise commit token, continuation tail alignment, independent failures, deferred ACK cleanup and cancellation fencing')
})().catch(error=>{console.error(error);process.exitCode=1})
