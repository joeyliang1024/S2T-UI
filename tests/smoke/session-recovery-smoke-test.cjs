const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const result = buildSync({entryPoints:['src/renderer/src/features/app/services/session-recovery.ts'],bundle:true,format:'cjs',platform:'node',write:false})
const m={exports:{}};new Function('module','exports',result.outputFiles[0].text)(m,m.exports)
const {recoverSession,sessionRecoveryStages}=m.exports
const base={id:'test',processingState:'failed',processingError:'original',transcript:'keep',segments:[{id:'good',status:'final',sourceText:'keep',translatedText:'kept',translationStatus:'completed'},{id:'bad',status:'final',sourceText:'retry',translationStatus:'failed'}]}
;(async()=>{
 const calls=[],states=[]
 const handlers=Object.fromEntries(['asr','translation','saving','diarization'].map(stage=>[stage,async e=>{calls.push(stage);return {...e,segments:e.segments.map(s=>s.id==='bad'?{...s,translatedText:'fixed',translationStatus:'completed'}:s)}}]))
 const fixed=await recoverSession(base,handlers,e=>states.push(e))
 assert.deepEqual(calls,['translation']);assert.equal(fixed.processingState,'completed');assert.equal(fixed.processingError,undefined);assert.equal(fixed.segments[0],base.segments[0]);assert.deepEqual(fixed.processingFailures,[])
 calls.length=0;const failed=await recoverSession({...base,processingFailures:['translation','diarization']},{...handlers,translation:async(e,publish)=>{publish({...e,transcript:'partial saved'});throw Error('still failing')}},()=>{})
 assert.equal(failed.transcript,'partial saved');assert.equal(failed.processingError,'still failing');assert.deepEqual(failed.processingFailures,['translation','diarization']);assert.deepEqual(calls,[])
 assert.deepEqual(sessionRecoveryStages({...base,segments:[],audioUnavailable:true,processingFailures:['diarization']}),['saving','diarization'])
 assert.deepEqual(sessionRecoveryStages({...base,segments:[],audioUnavailable:true,processingState:'completed'}),[],'transcript-only records are not failures')
 assert.deepEqual(sessionRecoveryStages({...base,segments:[],diarizationJobId:'completed-old-job'}),[],'job presence cannot imply job failure')
 await assert.rejects(()=>recoverSession({...base,segments:[],processingFailures:[]},handlers,()=>{}),/unknown-stage/)
 const worker=require('../../server/diarization-session.cjs')
 const source={...base,audioKey:'a',processingError:undefined,processingFailures:['asr']};assert.equal(worker.finalizeDiarizationSession(source,{sessionId:'test',audioKey:'a'},[]).processingState,'failed')
 console.log('PASS only failed stages retry, successful work preserved, partial retry progress survives failure, unknown legacy failures do not rerun all work, completed diarization cannot hide ASR failures')
})().catch(e=>{console.error(e);process.exitCode=1})
