const assert=require('node:assert/strict'),fs=require('node:fs'),{buildSync,transformSync}=require('esbuild')
const load=path=>{const code=buildSync({entryPoints:[path],bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text;const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require);return m.exports}
const recovery=load('src/renderer/src/features/app/services/session-recovery.ts'),wav=load('src/renderer/src/features/transcript/wav-batch.ts'),http=load('src/renderer/src/shared/services/http.ts')
const source=fs.readFileSync('src/renderer/src/features/app/hooks/useAppController.ts','utf8');const fragment=source.slice(source.indexOf('const retryFailedSession ='),source.indexOf('const finalizeSession ='))
const code=transformSync(fragment,{loader:'ts',target:'es2022'}).code
const data=Buffer.alloc(44+64000);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(64000,40);const audio=new Blob([data],{type:'audio/wav'})
const good={id:'good',status:'final',startMs:1000,endMs:2000,sourceText:'kept',translatedText:'keep translation',translationStatus:'completed',speaker:'manual',speakerManuallyEdited:true}
const base={id:'record',title:'test',audioKey:'record',durationMs:2000,createdAt:'2026-10-11',source:'test',processingState:'failed',processingError:'failed',segments:[good],transcript:'kept'}
async function run(entry,options={}){
 let sessions=[entry],requests=[],asr=0,translations=0,uploads=0,status=[]
 const context={...recovery,...wav,...http,crypto:require('node:crypto').webcrypto,window:{},File,Blob,AbortSignal,
 recoveryActiveRef:{current:new Set()},qualityCorrectionActiveRef:{current:new Set()},settings:{sourceLanguage:'en',targetLanguage:'zh-TW',glossary:'',diarizationEndpoint:'/api/diarizations',diarizationModel:'mock'},selectedModel:{kind:'openai-http',id:'mock',endpoint:'/api/transcriptions',model:'mock',capabilities:{supportedSampleRates:[16000]}},webGatewayAsrProfileId:'default',translationReady:true,
 loadSessionAudio:async()=>audio,activeAudioVersionFor:e=>({audioKey:e.audioKey}),activeTranslate:key=>key,
 setSessions:update=>{sessions=update(sessions)},setStatus:message=>status.push(message),makeTranscriptText:entries=>entries.filter(e=>e.status==='final').map(e=>e.sourceText).join('\n'),chooseModelSampleRate:rate=>rate,resampleAudioForAsr:async a=>a,asrLanguage:()=> 'en',headerValue:encodeURIComponent,
 shouldSkipTranslation:()=>false,resolveTranslationTarget:()=> 'zh-TW',translationTransportRef:{current:async e=>{translations++;return 'recovered '+e.sourceText}},
 remoteSessionStorage:{saveAudio:async()=>{uploads++}},authFetch:async(path,init)=>{requests.push(path);if(path.includes('diarizations'))return new Response(JSON.stringify({turns:[{start:0,end:2,speaker:'fixed'}]}));return new Response(JSON.stringify(options.saveFails?{error:'storage retry failed'}:{}),{status:options.saveFails?503:200})},
 requestBrowserAsr:async init=>{asr++;const layout=await wav.readPcmWavFileLayout(new File([init.body],'chunk.wav'));assert.ok(layout.dataBytes<=32000,'only failed one-second audio range is sent');if(options.asrFailsAt===asr)throw Error('ASR retry failed');return new Response(JSON.stringify({text:'recovered range'}))},
 parseSpeakerTurns:p=>p.turns,assignSpeakersByOverlap:entries=>entries.map(e=>({...e,speaker:'fixed'}))}
 const retry=new Function(...Object.keys(context),code+';return retryFailedSession')(...Object.values(context))
 await retry(entry,options.backup)
 return {session:sessions[0],requests,asr,translations,uploads,status}
}
;(async()=>{
 const translation=await run({...base,processingFailures:['translation'],segments:[good,{id:'bad',status:'final',startMs:0,endMs:1000,sourceText:'bad',translatedText:'old failed translation',translationStatus:'failed'}]})
 assert.equal(translation.translations,1);assert.equal(translation.asr,0);assert.deepEqual(translation.requests,[]);assert.equal(translation.session.segments[0],good);assert.equal(translation.session.processingState,'completed')
 const gap={id:'gap',status:'gap',gapReason:'request-failed',startMs:0,endMs:1000,sourceText:''}
 const asr=await run({...base,segments:[gap,good],processingFailures:['asr']});assert.equal(asr.asr,1);assert.equal(asr.translations,0);assert.equal(asr.session.segments[1],good);assert.equal(asr.session.processingState,'completed')
 const partial=await run({...base,processingFailures:['asr'],segments:[gap,{...gap,id:'gap2',startMs:1000,endMs:2000}]},{asrFailsAt:2});assert.equal(partial.session.segments[0].status,'final');assert.equal(partial.session.segments[1].status,'gap');assert.equal(partial.session.processingState,'failed');const retried=await run(partial.session);assert.equal(retried.asr,1,'completed first range is not repeated')
 const speaker=await run({...base,processingFailures:['diarization'],segments:[good,{...good,id:'other',speakerManuallyEdited:false,speaker:undefined}]});assert.equal(speaker.asr,0);assert.equal(speaker.translations,0);assert.deepEqual(speaker.requests,['/api/diarizations']);assert.equal(speaker.session.segments[0].speaker,'manual');assert.equal(speaker.session.segments[1].speaker,'fixed')
 const save=await run({...base,processingFailures:['saving'],audioUnavailable:true},{backup:new File([audio],'backup.wav')});assert.equal(save.uploads,1);assert.equal(save.asr,0);assert.equal(save.translations,0);assert.equal(save.session.audioUnavailable,false)
 const saveFailed=await run({...base,processingFailures:['saving'],audioUnavailable:true},{saveFails:true});assert.equal(saveFailed.session.audioUnavailable,false,'completed upload survives metadata failure');const metadata=await run(saveFailed.session);assert.equal(metadata.uploads,0,'completed upload is not repeated');assert.equal(metadata.session.processingState,'completed')
 console.log('PASS production handlers: failed translation only, ASR gap ranges only, partial ASR progress retained, speaker manual labels preserved, audio backup restore, metadata retry does not repeat upload; no real API calls')
})().catch(e=>{console.error(e);process.exitCode=1})
