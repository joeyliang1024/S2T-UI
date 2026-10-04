const assert=require('node:assert/strict'), {readFileSync}=require('node:fs'),ts=require('typescript'),{buildSync}=require('esbuild')
const hook=readFileSync('src/renderer/src/features/app/hooks/useAppController.ts','utf8')
const source=hook.slice(hook.indexOf('const finalizeSession ='),hook.indexOf('const appendAudio ='))
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve()}
async function scenario(fail=false){
 let progress={other:{stage:'completed',completed:1,total:1}},sessions=[{id:'test',createdAt:new Date().toISOString(),segments:[],audioKey:'audio'}],requests=0
 const audio=deferred(),asrs=[deferred(),deferred()],speaker=deferred(),active={current:new Set()}
 const ctx={qualityCorrectionActiveRef:active,setStatus:()=>{},activeTranslate:key=>key,selectedModel:{kind:'openai-http',capabilities:{}},setQualityCorrectionProgress:update=>{progress=update(progress)},loadSessionAudio:()=>audio.promise,
 readPcmWavFileLayout:async()=>({sampleRate:48000}),pcmWavChunkCount:()=>2,readPcmWavFileChunk:async(_file,_layout,offset)=>({audio:new ArrayBuffer(4),startMs:offset*1000,endMs:(offset+1)*1000}),nextPcmWavChunkStart:(_layout,offset)=>offset+1,chooseModelSampleRate:()=>48000,
 window:{},settings:{sourceLanguage:'zh-TW',glossary:''},asrLanguage:()=> 'zh',webGatewayAsrProfileId:'mock',headerValue:x=>x,
 requestBrowserAsr:async()=>{const i=requests++;await asrs[i].promise;return new Response(JSON.stringify({text:`sentence ${i}`}),{status:200})},readJsonResponse:response=>response.json(),
 joinOverlappedText:(first,next)=>`${first} ${next}`,authFetch:()=>speaker.promise,assignSpeakersByOverlap:entries=>entries,parseSpeakerTurns:()=>[],makeTranscriptText:entries=>entries.map(e=>e.sourceText).join('\n'),setSessions:update=>{sessions=update(sessions)},automaticSessionTitle:()=> 'corrected',audioVersionsFor:()=>[],activeAudioVersionFor:()=>({id:'original',audioKey:'audio'}),generateSessionTitle:async()=>{}}
 const finalize=new Function(...Object.keys(ctx),code+';return finalizeSession')(...Object.values(ctx))
 const task=finalize(sessions[0]);assert.equal(progress.test.stage,'loading');assert.ok(active.current.has('test'))
 await finalize(sessions[0]);assert.equal(requests,0,'repeat click cannot enqueue another correction')
 audio.resolve(new Blob(['mock wav']));await flush();assert.equal(progress.test.stage,'asr');assert.equal(progress.test.completed,0);assert.equal(progress.test.total,3)
 if(fail){asrs[0].reject(new Error('mock failure'));await task;assert.equal(progress.test.stage,'failed');assert.equal(progress.test.error,'mock failure');assert.equal(active.current.size,0);assert.equal(sessions[0].qualityCorrectionState,'failed')}
 else{asrs[0].resolve();await flush();assert.equal(progress.test.completed,1);assert.equal(requests,2);asrs[1].resolve();await flush();assert.equal(progress.test.stage,'diarization');assert.equal(progress.test.completed,2,'not 100% before speaker processing completes');speaker.resolve(new Response('{}',{status:200}));await task;assert.equal(progress.test.stage,'completed');assert.equal(progress.test.completed,progress.test.total);assert.equal(active.current.size,0);assert.equal(sessions[0].segments.length,2);assert.equal(sessions[0].qualityCorrectionState,'completed')}
 assert.deepEqual(progress.other,{stage:'completed',completed:1,total:1},'only the selected row changes')
}
async function main(){global.fetch=()=>{throw Error('Real API forbidden')};await scenario();await scenario(true)
 const view=readFileSync('src/renderer/src/features/app/views/AppView.tsx','utf8'),start=view.indexOf('const qualityCorrectionRunning ='),end=view.indexOf('const sessionTranscript =',start)
 const bundle=buildSync({stdin:{contents:`import React from 'react'; const ui=key=>key; let processingDetailsId=null; const setProcessingDetailsId=value=>{processingDetailsId=value}; const qualityCorrectionProgress={test:{stage:'asr',completed:1,total:3},failed:{stage:'failed',completed:0,total:3,error:'mock failure'}}; ${view.slice(start,end)};export {qualityCorrectionBar,qualityCorrectionBadge};`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text
 const m={exports:{}};new Function('module','exports','require',bundle)(m,m.exports,require)
 const render=require('react-dom/server').renderToStaticMarkup
 assert.equal(m.exports.qualityCorrectionBar({id:'untouched'}),null)
 assert.match(render(m.exports.qualityCorrectionBar({id:'test'})),/value="1"/)
 assert.match(render(m.exports.qualityCorrectionBar({id:'test'})),/33%/)
 assert.equal(m.exports.qualityCorrectionBar({id:'failed'}),null,'failed correction hides the bar')
 assert.equal(m.exports.qualityCorrectionBar({id:'other',qualityCorrectionState:'completed'}),null)
 const done=render(m.exports.qualityCorrectionBadge({id:'persisted',qualityCorrectionState:'completed'}));assert.match(done,/>qualityCorrection</);assert.doesNotMatch(done,/recordProcessingCompleted|recordProcessingFailed/);assert.match(done,/session-quality-badge completed/);assert.doesNotMatch(done,/<progress/)
 const failedBadge=m.exports.qualityCorrectionBadge({id:'failed'});assert.match(render(failedBadge),/session-quality-badge failed/);assert.match(render(failedBadge),/>qualityCorrection</);assert.doesNotMatch(render(failedBadge),/mock failure/)
 failedBadge.props.children[0].props.onClick();assert.match(render(m.exports.qualityCorrectionBadge({id:'failed'})),/mock failure/)
 assert.equal(m.exports.qualityCorrectionBadge({id:'test',qualityCorrectionState:'completed'}),null,'previous badge hides while a new correction runs')
 console.log('Quality progress smoke passed: immediate row progress, completed chunks, final speaker phase, success/failure, duplicate click protection, independent rows. No real API calls.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
