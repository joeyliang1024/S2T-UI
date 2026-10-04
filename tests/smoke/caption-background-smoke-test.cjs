const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { buildSync } = require('esbuild')
const ts = require('typescript')
const { finalizeDiarizationSession, matchesJob } = require('../../server/diarization-session.cjs')
const code = buildSync({ stdin: { contents: `export * from './src/renderer/src/features/app/services/live-caption'; export * from './src/renderer/src/features/app/services/translation-queue'; export * from './src/renderer/src/features/app/services/translation-policy'; export * from './src/renderer/src/features/app/services/session-merge'; export * from './src/renderer/src/shared/services/transcript'; export * from './src/renderer/src/features/speakers/diarization'; export * from './src/renderer/src/shared/services/http';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module', 'exports', 'require', code)(m, m.exports, require)
const { freezeCaptionGroups, HttpServiceError, TranslationQueue, makeTranscriptText, mergeSessions, recoverStaleProcessing, assignSpeakersByOverlap, parseSpeakerTurns, readJsonResponse, shouldSkipTranslation, resolveTranslationTarget } = m.exports
const hook = readFileSync('src/renderer/src/features/app/hooks/useAppController.ts', 'utf8')
const stopSource = hook.slice(hook.indexOf('const stopCapture ='), hook.indexOf('const exportTranscript ='))
const stopCode = ts.transpileModule(stopSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const flush = async () => { for (let i=0;i<60;i++) await Promise.resolve() }
const ref = current => ({ current })
const caption = (id, startMs=0) => ({ id, status:'final', revision:1, sourceText:`句子 ${id}`, startMs, endMs:startMs+1000, detectedLanguage:'zh-TW' })
async function capture({ continuation=false, diarization=false, translateFails=false, audioFails=false, stopFails=false }={}) {
  let sessions = continuation ? [{ id:'continued', title:'old', createdAt:new Date(0).toISOString(), durationMs:2000, audioKey:'continued', segments:[caption('old')], transcript:'old', source:'mic' }] : []
  let view='live', state='recording', listener, requests=[]
  const asr = deferred(), translation = deferred(), audio = deferred()
  const finishing = ref(null), transcripts = ref(continuation ? [caption('old'),caption('new',2000)] : [caption('new')])
  const setSessions = update => { sessions=update(sessions) }
  const setTranscripts = update => {
    transcripts.current=update(transcripts.current)
    if (finishing.current) sessions=sessions.map(entry=>entry.id===finishing.current.id && entry.processingToken===finishing.current.token
      ? {...entry,segments:transcripts.current,transcript:makeTranscriptText(transcripts.current)} : entry)
  }
  const queue = new TranslationQueue(()=>transcripts.current,setTranscripts,()=>{})
  const context = { setTranscripts, activeTranslate:key=>key,
    recorderRef:ref({ addEventListener:(_name,fn)=>{listener=fn},stop:()=>{if(stopFails)throw new Error('stop failed');listener()} }),
    savedLiveSnapshotRef:ref(null),finishingSessionRef:finishing,pauseStartedAtRef:ref(null),pausedDurationRef:ref(0),pausedRef:ref(false),translationQueueRef:ref(queue),
    setCaptureState:value=>{state=value},cleanUpCapture:()=>{},continuationTargetRef:ref(continuation ? {entry:sessions[0],audio:new Blob(['old']),baseDurationMs:2000} : null),
    sessionsRef:{get current(){return sessions}},startAtRef:ref(Date.now()-1000),selectedDeviceId:'default',devices:[],includeSystemAudio:false,transcriptsRef:transcripts,setSessions,
    automaticSessionTitle:()=> 'title',setHistorySearch:()=>{},setHistoryPage:()=>{},setView:value=>{view=value},setStatus:()=>{},
    translationTransportRef:ref(async entry=>{await translation.promise; if(translateFails) { throw new HttpServiceError('translation failed',400) } return `translated ${entry.id}`}),
    resamplerRef:ref(null),sampleOffsetRef:ref(0),modelRef:ref({stop:()=>asr.promise}),translationReady:true,
    settings:{targetLanguage:'en',translationStrategy:'realtime',translationLoadStrategy:'auto',diarizationModel:diarization?'mock':'',diarizationPreviewEnabled:false,diarizationEndpoint:''},
    translationElapsedMsRef:ref(10000),OpenAiChunkedModelAdapter:class {},shouldSkipTranslation,resolveTranslationTarget,
    electronRecordingIdRef:ref(null),pcmWriterRef:ref(null),opfsRecordingRef:ref(null),opfsRecordingIdRef:ref(null),pcmChunksRef:ref([]),sampleRateRef:ref(16000),
    makeWav:()=>new Blob(['fake audio']),appendAudio:async()=>new Blob(['merged audio']),makeTranscriptText,
    remoteSessionStorage:{saveAudio:async()=>{await audio.promise;if(audioFails)throw new Error('audio failed')},deleteAudio:async()=>{}},browserDownload:()=>{},
    activeModelSnapshotRef:ref(null),activeAudioVersionFor:entry=>({audioKey:entry.audioKey}),audioVersionsFor:()=>[],liveSessionIdRef:ref(null),liveDraftRef:ref(null),
    generateSessionTitle:async()=>{},readJsonResponse,authFetch:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({job:{id:'mock-job'}}),{status:202})},
    freezeCaptionGroups,assignSpeakersByOverlap,parseSpeakerTurns,memoryRecordingBytesRef:ref(0),memoryRecordingLimitReachedRef:ref(false),pcmWriterPausedRef:ref(false),pcmWriterFailedRef:ref(false),setMicrophoneLevel:()=>{},setSystemLevel:()=>{},window:{},
    console:{info:()=>{}}
  }
  // Run the production stop function with held dependencies; no model or storage network.
  const stop = new Function(...Object.keys(context),stopCode+'; return stopCapture')(...Object.values(context))
  const pending = stop()
  assert.equal(view,'history','navigate before any awaited tail work')
  assert.equal(sessions.length,1,'continuation remains one record')
  const id=sessions[0].id
  await flush()
  if(stopFails){ await pending;assert.equal(sessions[0].processingState,'failed');return }
  assert.equal(sessions[0].processingState,'running');assert.equal(sessions[0].processingStage,'asr')
  setTranscripts(current=>[...current,caption('tail',3000)])
  assert.ok(sessions[0].segments.some(entry=>entry.id==='tail'),'tail appears in history while ASR still runs')
  asr.resolve();await flush();assert.equal(sessions[0].processingStage,'translation')
  translation.resolve();for(let i=0;i<60 && sessions[0].processingStage==='translation';i++)await new Promise(resolve=>setTimeout(resolve,50));await flush();assert.equal(sessions[0].processingStage,'saving')
  if(!translateFails)assert.ok(sessions[0].segments.every(entry=>entry.translatedText),'translation updates history while upload still pending')
  audio.resolve();await pending;await flush()
  assert.equal(state,'idle');assert.equal(sessions.length,1);assert.equal(sessions[0].id,id)
  assert.equal(queue.inFlight,0);assert.equal(finishing.current,null)
  assert.deepEqual(sessions[0].audioVersions[0].segments,sessions[0].segments)
  if(diarization){assert.equal(requests.length,1,'final speaker pass runs despite preview disabled');assert.equal(sessions[0].diarizationJobId,'mock-job');assert.equal(sessions[0].processingState,'running');assert.equal(sessions[0].processingStage,'diarization');assert.equal(requests[0].body.processingToken,sessions[0].processingToken)}
  else assert.equal(sessions[0].processingState,translateFails||audioFails?'failed':'completed')
  return sessions[0]
}
async function main(){
  global.window={setTimeout,clearTimeout}
  global.fetch=()=>{throw new Error('Real network is forbidden in this test')}
  const viewSource=readFileSync('src/renderer/src/features/app/views/AppView.tsx','utf8')
  const badgeSource=viewSource.slice(viewSource.indexOf('const processingBadge ='),viewSource.indexOf('const sessionTranscript ='))
  const badgeCode=buildSync({stdin:{contents:`import React from 'react'; import { interfaceTranslate } from './src/renderer/src/shared/i18n'; const ui=(key)=>interfaceTranslate('en',key); let processingDetailsId=null; const setProcessingDetailsId=(value)=>{processingDetailsId=value}; ${badgeSource}; export { processingBadge };`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text
  const badgeModule={exports:{}};new Function('module','exports','require',badgeCode)(badgeModule,badgeModule.exports,require)
  const render=require('react-dom/server').renderToStaticMarkup
  assert.match(render(badgeModule.exports.processingBadge({})),/>Complete</)
  assert.match(render(badgeModule.exports.processingBadge({id:'running',processingState:'running',processingStage:'translation'})),/>In progress</)
  const failedBadge={id:'failed',processingState:'failed',processingError:'timeout'}
  const collapsed=badgeModule.exports.processingBadge(failedBadge)
  assert.match(render(collapsed),/>Incomplete</)
  assert.doesNotMatch(render(collapsed),/timeout/,'error is hidden before clicking')
  collapsed.props.children[0].props.onClick()
  const expanded=badgeModule.exports.processingBadge(failedBadge)
  assert.match(render(expanded),/timeout/,'click reveals error')
  assert.match(render(expanded),/aria-expanded="true"/)
  assert.doesNotMatch(render(badgeModule.exports.processingBadge(failedBadge,'modal')),/timeout/,'modal and card disclosures have separate IDs')
  expanded.props.children[0].props.onClick()
  assert.doesNotMatch(render(badgeModule.exports.processingBadge(failedBadge)),/timeout/,'click again collapses error')

  await capture(); await capture({continuation:true});await capture({translateFails:true});await capture({audioFails:true});await capture({stopFails:true})
  const running=await capture({diarization:true})
  running.segments[0]={...running.segments[0],speaker:'manual',speakerManuallyEdited:true}
  const job={sessionId:running.id,audioKey:running.audioKey,payload:{processingToken:running.processingToken}}
  const done=finalizeDiarizationSession(running,job,[{start:0,end:6,speaker:'speaker1'}])
  assert.equal(done.processingState,'completed');assert.equal(done.segments[0].speaker,'manual');assert.equal(done.segments.at(-1).speaker,'speaker1')
  assert.deepEqual(done.audioVersions[0].segments,done.segments);assert.equal(done.transcript,makeTranscriptText(done.segments),'export text retains timestamps/translations')
  assert.ok(done.segments.every(entry=>entry.translatedText));assert.equal(matchesJob({...running,processingToken:'new'},job),false)
  assert.equal(finalizeDiarizationSession({...running,processingToken:'new'},job,[]).processingState,'running','stale job is ignored')
  assert.equal(finalizeDiarizationSession({...running,processingError:'translation timeout'},job,[]).processingState,'failed')
  const workerSource=readFileSync('server/index.cjs','utf8')
  const workerCode=workerSource.slice(workerSource.indexOf('const runDurableDiarizationJob ='),workerSource.indexOf('const staticFile ='))
  const runWorker=async(target,latest=target,owns=true)=>{
    let inference=0,writes=0,finishedError,stored,reads=0,renewals=0,cleared=0
    const context={setInterval:fn=>{fn();return {unref(){}}},clearInterval:()=>{cleared++},storage:{config:{renewDiarizationJob:async()=>{renewals++;return true},claimDiarizationJob:async()=>({...job,id:'job',attempts:1,userId:'test',leaseGeneration:1,payload:{...job.payload,user:{id:'test'}}}),get:async()=>({sessions:[reads++?latest:target],version:1}),stillOwnsDiarizationJob:async()=>owns,compareAndSwap:async(_user,_key,_version,value)=>{writes++;stored=value;return true},finishDiarizationJob:async(_id,_owner,_generation,error)=>{finishedError=error}},blob:{get:async()=>Buffer.from('fake')}},diarizationJobMaxAttempts:10,logger:{info:()=>{},warn:()=>{},error:()=>{}},matchesJob,finalizeDiarizationSession,accountModelService:async()=>null,diarizeWav:async()=>{inference++;return [{start:0,end:6,speaker:'speaker1'}]},labelDiarizationTurns:async(_user,_audio,turns)=>turns}
    await new Function(...Object.keys(context),workerCode+'; return runDurableDiarizationJob')(...Object.values(context))({},'owner')
    assert.equal(renewals,1);assert.equal(cleared,1);return {inference,writes,finishedError,stored}
  }
  const workerDone=await runWorker(running);assert.equal(workerDone.inference,1);assert.equal(workerDone.writes,1);assert.equal(workerDone.stored.sessions[0].processingState,'completed')
  const stale=await runWorker({...running,processingToken:'new'});assert.equal(stale.inference,0);assert.equal(stale.writes,0)
  const provisional=await runWorker({...running,processingStage:'asr'});assert.equal(provisional.inference,0);assert.match(provisional.finishedError,/^retry:/)
  const expired=await runWorker(running,running,false);assert.equal(expired.writes,0,'expired worker lease cannot publish')
  const replaced=await runWorker(running,{...running,processingToken:'new'});assert.equal(replaced.writes,0,'generation change during inference cannot publish')
  const saveSource=hook.slice(hook.indexOf('const saveLiveCaptionsBeforeSwitch ='),hook.indexOf('const loadSessionIntoLive ='))
  let saved=0
  const preview=running.segments
  const saveContext={transcriptsRef:ref(preview),makeTranscriptText,liveSessionIdRef:ref(done.id),sessions:[done],savedLiveSnapshotRef:ref(preview),setSessions:()=>{saved++}}
  const saveCode=ts.transpileModule(saveSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  await new Function(...Object.keys(saveContext),saveCode+';return saveLiveCaptionsBeforeSwitch')(...Object.values(saveContext))()
  assert.equal(saved,0,'unchanged live preview cannot overwrite final history speaker labels')
  const other={...running,id:'other',title:'new unrelated edit'}
  const rebased=mergeSessions([running,other],[done,{...other,title:'old remote title'}])
  assert.equal(rebased.find(entry=>entry.id===running.id).processingState,'completed','server completion wins stale CAS snapshot')
  assert.equal(rebased.find(entry=>entry.id==='other').title,'new unrelated edit')
  assert.equal(mergeSessions([{...running,processingToken:'new'}],[done])[0].processingToken,'new')
  // A record nobody is left to finish must not stay `running`: continue,
  // summarize, quality-correct and load are all gated on that state, and only
  // delete was ever left open.
  const unresumable={...running,processingStage:'diarization',diarizationJobId:'mock-job'}
  const recovered=recoverStaleProcessing([unresumable])
  assert.equal(recovered[0].processingState,'failed','without a durable watcher the record can never be finished')
  assert.ok(recovered[0].processingError&&recovered[0].processingStage===undefined,'recovery explains itself and clears the stage badge')
  assert.equal(recoverStaleProcessing([unresumable],{durableJobs:true})[0].processingState,'running','a durable job keeps waiting for the poller')
  const inline={...unresumable,diarizationJobId:undefined}
  assert.equal(recoverStaleProcessing([inline],{durableJobs:true,finishing:{id:inline.id,token:inline.processingToken}})[0].processingState,'running','a record this page is finishing is never demoted')
  assert.equal(recoverStaleProcessing([inline],{durableJobs:true,finishing:{id:inline.id,token:'stale-token'}})[0].processingState,'failed','only this page\'s own capture token keeps a record running')
  const settled=recoverStaleProcessing([{...unresumable,processingState:'completed',processingStage:undefined}])
  assert.equal(settled[0].processingState,'completed')
  assert.equal(recoverStaleProcessing(settled),settled,'an unchanged list keeps its identity so setSessions schedules no save')
  console.log('Background stop smoke passed: immediate history, tail/translation progress, continuation, failures, final diarization, active audio snapshot, stale generation and CAS rebase. No network/API calls.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
