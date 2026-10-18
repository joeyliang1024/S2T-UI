const assert=require('node:assert/strict'), {readFileSync}=require('node:fs'),ts=require('typescript'),{buildSync}=require('esbuild')
const hook=readFileSync('src/renderer/src/features/app/hooks/useAppController.ts','utf8')
const source=hook.slice(hook.indexOf('const finalizeSession ='),hook.indexOf('const appendAudio ='))
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve()}
async function scenario(fail=false,failedStage){
 let progress={other:{stage:'completed',completed:1,total:1}},sessions=[{id:'test',createdAt:new Date().toISOString(),segments:[{id:'a',revision:1,status:'final',sourceText:'old a',startMs:0,endMs:1000,isSentenceBoundary:true},{id:'b',revision:1,status:'final',sourceText:'old b',startMs:1000,endMs:2000,isSentenceBoundary:true}],audioKey:'audio'}],requests=0
 if(failedStage) sessions[0]={...sessions[0],processingState:'failed',processingFailures:[failedStage],processingError:'prior '+failedStage+' failure',qualityCorrectionState:'failed',qualityCorrectionError:'previous correction failed',summaryError:'previous summary failed'}
 const audio=deferred(),asrs=[deferred(),deferred()],speaker=deferred(),active={current:new Set()}
 const ctx={qualityCorrectionActiveRef:active,setStatus:()=>{},activeTranslate:key=>key,selectedModel:{kind:'openai-http',capabilities:{}},setQualityCorrectionProgress:update=>{progress=update(progress)},loadSessionAudio:()=>audio.promise,
 readPcmWavFileLayout:async()=>({sampleRate:48000}),pcmWavChunkCount:()=>2,readPcmWavFileChunk:async(_file,_layout,offset)=>({audio:new ArrayBuffer(4),startMs:offset*1000,endMs:(offset+1)*1000}),nextPcmWavChunkStart:(_layout,offset)=>offset+1,chooseModelSampleRate:()=>48000,
 window:{},settings:{sourceLanguage:'zh-TW',glossary:'',diarizationModel:'mock'},asrLanguage:()=> 'zh',webGatewayAsrProfileId:'mock',headerValue:x=>x,
 requestBrowserAsr:async()=>{const i=requests++;await asrs[i].promise;return new Response(JSON.stringify({text:`sentence ${i}`}),{status:200})},readJsonResponse:response=>response.json(),
 joinOverlappedText:(first,next)=>`${first} ${next}`,authFetch:()=>speaker.promise,assignSpeakersByOverlap:entries=>entries,parseSpeakerTurns:()=>[{start:0,end:1,speaker:'speaker'}],makeTranscriptText:entries=>entries.map(e=>e.sourceText).join('\n'),setSessions:update=>{sessions=update(sessions)},automaticSessionTitle:()=> 'corrected',audioVersionsFor:()=>[],activeAudioVersionFor:()=>({id:'original',audioKey:'audio'}),generateSessionTitle:async()=>{}}
 ctx.correctionGroups=entry=>entry.map(item=>({...item,members:[item]}));ctx.correctedCaption=(group,text)=>({...group,sourceText:text});ctx.readPcmWavSentence=async(_file,_layout,startMs,endMs)=>({audio:new ArrayBuffer(4),startMs,endMs});ctx.transcribeCorrection=async()=>{const i=requests++;await asrs[i].promise;return{text:`sentence ${i}`}}
 const finalize=new Function(...Object.keys(ctx),code+';return finalizeSession')(...Object.values(ctx))
 const task=finalize(sessions[0]);assert.equal(progress.test.stage,'loading');assert.ok(active.current.has('test'))
 await finalize(sessions[0]);assert.equal(requests,0,'repeat click cannot enqueue another correction')
 audio.resolve(new Blob(['mock wav']));await flush();assert.equal(progress.test.stage,'asr');assert.equal(progress.test.completed,0);assert.equal(progress.test.total,3)
 if(fail){asrs[0].reject(new Error('mock failure'));await task;assert.equal(progress.test.stage,'failed');assert.equal(progress.test.error,'mock failure');assert.equal(active.current.size,0);assert.equal(sessions[0].qualityCorrectionState,'failed')}
 else{asrs[0].resolve();await flush();assert.equal(progress.test.completed,1);assert.equal(requests,2);asrs[1].resolve();await flush();assert.equal(progress.test.stage,'diarization');assert.equal(progress.test.completed,2,'not 100% before speaker processing completes');speaker.resolve(new Response('{}',{status:200}));await task;assert.equal(progress.test.stage,'completed');assert.equal(progress.test.completed,progress.test.total);assert.equal(active.current.size,0);assert.equal(sessions[0].segments.length,2);assert.equal(sessions[0].qualityCorrectionState,'completed')}
 assert.deepEqual(progress.other,{stage:'completed',completed:1,total:1},'only the selected row changes')
}
async function selectionScenario(items, failure) {
 const calls={audio:0,asr:0,diarization:0,translation:0}
 let sessions=[{id:'selected',createdAt:new Date().toISOString(),audioKey:'audio',segments:[{id:'s',status:'final',sourceText:'Original',translatedText:'Old translation',speaker:'Old speaker',startMs:0,endMs:1000,revision:1}]}]
 let progress={}
 const ctx={settings:{diarizationModel:'speaker',diarizationEndpoint:'/api/diarizations',diarizationProfiles:[{model:'speaker',endpoint:'/api/diarizations'}],translationModel:'translator'},selectedModel:{kind:items.includes('transcript')?'openai-http':'websocket',capabilities:{}},qualityCorrectionActiveRef:{current:new Set()},activeTranslate:key=>key,setStatus:()=>{},setQualityCorrectionProgress:fn=>{progress=fn(progress)},loadSessionAudio:async()=>{calls.audio++;return new Blob(['audio'])},readPcmWavFileLayout:async()=>({sampleRate:16000}),correctionGroups:segments=>segments.map(segment=>({...segment,members:[segment]})),readPcmWavSentence:async()=>({audio:new ArrayBuffer(4)}),chooseModelSampleRate:()=>16000,transcribeCorrection:async()=>{calls.asr++;return{text:'Corrected'}},correctedCaption:(segment,text)=>({...segment,sourceText:text}),window:{},authFetch:async(_url,options)=>{calls.diarization++;assert.equal(options.headers['x-s2t-diarization-model'],'speaker');return new Response(failure==='http'?JSON.stringify({error:'Speaker service failed'}):'{}',{status:failure==='http'?503:200})},readJsonResponse:response=>response.json(),parseSpeakerTurns:()=>failure==='empty'?[]:[{start:0,end:1,speaker:'speaker'}],assignSpeakersByOverlap:segments=>segments.map(segment=>({...segment,speaker:'New speaker'})),translationTransportRef:{current:async()=>{calls.translation++;return{text:'New translation'}}},makeTranscriptText:segments=>segments.map(segment=>segment.sourceText).join(''),setSessions:fn=>{sessions=fn(sessions)},automaticSessionTitle:()=> 'Corrected',audioVersionsFor:()=>[],activeAudioVersionFor:()=>({id:'old',audioKey:'audio'}),generateSessionTitle:async()=>{}}
 const finalize=new Function(...Object.keys(ctx),code+';return finalizeSession')(...Object.values(ctx))
 await finalize(sessions[0],items)
 if(failure){assert.equal(progress.selected.stage,'failed');assert.equal(sessions[0].segments[0].sourceText,'Original');assert.equal(sessions[0].segments[0].speaker,'Old speaker');assert.equal(calls.translation,0);return}
 assert.equal(calls.asr,Number(items.includes('transcript')))
 assert.equal(calls.diarization,Number(items.includes('diarization')))
 assert.equal(calls.translation,Number(items.includes('translation')))
 assert.equal(calls.audio,Number(items.includes('transcript')||items.includes('diarization')))
 assert.equal(sessions[0].segments[0].sourceText,items.includes('transcript')?'Corrected':'Original')
 assert.equal(sessions[0].segments[0].speaker,items.includes('diarization')?'New speaker':'Old speaker')
 assert.equal(sessions[0].segments[0].translatedText,items.includes('translation')?'New translation':'Old translation')
 if(items.length)assert.equal(progress.selected.stage,'completed')
}
async function main(){global.fetch=()=>{throw Error('Real API forbidden')};await scenario();await scenario(true);for(const items of [[],['transcript'],['diarization'],['translation'],['transcript','diarization','translation']])await selectionScenario(items);for(const failure of ['http','empty'])await selectionScenario(['transcript','diarization','translation'],failure);for(const stage of ['asr','translation','diarization','saving'])await scenario(false,stage)
 const view=readFileSync('src/renderer/src/features/app/views/AppView.tsx','utf8'),start=view.indexOf('const qualityCorrectionRunning ='),end=view.indexOf('const sessionTranscript =',start)
 const bundle=buildSync({stdin:{contents:`const qualityCorrectionProgress={test:{stage:'asr'},loading:{stage:'loading'},speakers:{stage:'diarization'},translation:{stage:'translation'},done:{stage:'completed'},failed:{stage:'failed'}}; ${view.slice(start,end)};export {qualityCorrectionRunning};`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
 const m={exports:{}};new Function('module','exports','require',bundle)(m,m.exports,require)
 for(const id of ['test','loading','speakers','translation']) assert.equal(m.exports.qualityCorrectionRunning({id}),true)
 for(const id of ['done','failed','untouched']) assert.equal(m.exports.qualityCorrectionRunning({id}),false)
 assert.doesNotMatch(view,/qualityCorrectionBar|qualityCorrectionBadge|session-quality-/,'legacy history correction UI removed')
 assert.doesNotMatch(view,/void finalizeSession\(entry\)/,'history must not directly run quality correction')
 console.log('Quality progress smoke passed: correction-page progress, completed chunks, final speaker phase, success/failure, duplicate click protection, independent records and history mutation guards. No real API calls.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
