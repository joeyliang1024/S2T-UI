const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { requestLimits, createRequestLimiter, upstreamRateLimit } = require('../../server/request-limits.cjs')
const exportsCode = `export * from './src/renderer/src/features/app/services/translation-queue'; export * from './src/renderer/src/features/app/services/translation-policy'; export * from './src/renderer/src/features/app/services/live-caption'; export * from './src/renderer/src/features/models/model-adapter'; export * from './src/renderer/src/features/capture/vad'; export * from './src/renderer/src/shared/services/http'; export * from './src/renderer/src/features/speakers/diarization';`
const code = buildSync({ stdin: { contents: exportsCode, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { TranslationQueue, HttpServiceError, readJsonResponse, upsertLiveCaption, editCaptionContent, renderedLiveCaptionWindow, OpenAiChunkedModelAdapter, speedToVadConfig, assignSpeakersByOverlap } = m.exports
const flush = async () => { for(let i=0;i<40;i++) await Promise.resolve() }
class Clock {
 constructor(){this.now=0;this.id=0;this.tasks=new Map()}
 timer(fn,delay,repeat=0){const id=++this.id;this.tasks.set(id,{at:this.now+delay,fn,repeat});return id}
 wait(ms){return new Promise(resolve=>this.timer(resolve,ms))}
 async advance(to){await flush();while(true){let chosen;for(const pair of this.tasks)if(pair[1].at<=to&&(!chosen||pair[1].at<chosen[1].at))chosen=pair;if(!chosen)break;const [id,t]=chosen;this.now=t.at;if(t.repeat)t.at+=t.repeat;else this.tasks.delete(id);t.fn();await flush()}this.now=to;await flush()}
 window(){return {setTimeout:(f,d)=>this.timer(f,d),clearTimeout:id=>this.tasks.delete(id),setInterval:(f,d)=>this.timer(f,d,d),clearInterval:id=>this.tasks.delete(id)}}
}
const entry=(id,update={})=>({id:`http-${id}`,revision:1,status:'final',startMs:0,endMs:1200,sourceText:`測試${id}`,detectedLanguage:'zh-TW',...update})
const options={targetLanguage:'en',strategy:'realtime',elapsedMs:1000000}
const setup=(initial=[])=>{const clock=new Clock();let entries=initial;const queue=new TranslationQueue(()=>entries,u=>{entries=u(entries)},()=>{},()=>clock.now,ms=>clock.wait(ms));return {clock,queue,get entries(){return entries},update:u=>{entries=u(entries)}}}
const response=(status,payload,headers={})=>({status,ok:status<400,headers:new Headers(headers),text:async()=>JSON.stringify(payload)})
async function regressions(){
 assert.equal(requestLimits({}).translations,180)
 for(const value of ['0','-1','2.5','invalid','Infinity',''])assert.equal(requestLimits({S2T_ASR_REQUESTS_PER_MINUTE:value}).transcriptions,180)
 assert.equal(requestLimits({S2T_TRANSLATION_REQUESTS_PER_MINUTE:'60'}).translations,60)
 let time=0;const accept=createRequestLimiter({translations:2},()=>time)
 assert.ok(accept('user:a','translations').accepted);assert.ok(accept('user:a','translations').accepted);assert.equal(accept('user:a','translations').accepted,false);assert.ok(accept('user:b','translations').accepted)
 time=60000;assert.ok(accept('user:a','translations').accepted)
 assert.deepEqual(upstreamRateLimit({status:429,headers:new Headers({'retry-after':'15'})}),{retryAfterSeconds:15})
 assert.equal(upstreamRateLimit({status:502}),null)
 assert.deepEqual(upstreamRateLimit({status:429}),{retryAfterSeconds:30})
 await assert.rejects(readJsonResponse(response(429,{error:'limit',retryAfterSeconds:15}),'test'),e=>e instanceof HttpServiceError&&e.status===429&&e.retryAfterSeconds===15)
 await assert.rejects(readJsonResponse({status:429,ok:false,headers:new Headers({'retry-after':'15'}),text:async()=>''},'test'),e=>e.status===429&&e.retryAfterSeconds===15)
 const parallel=setup([entry('skip1',{detectedLanguage:'en-US'}),entry('skip2',{detectedLanguage:'en-US'}),entry(1),entry(2)])
 let active=0,peak=0
 const slow=async()=>{active++;peak=Math.max(peak,active);await parallel.clock.wait(2000);active--;return '譯文'}
 parallel.queue.tick(options,slow);await flush();assert.equal(parallel.queue.inFlight,2);await parallel.clock.advance(2000);assert.equal(peak,2);assert.equal(parallel.entries.filter(e=>e.translatedText).length,2)
 const throttled=setup([entry(1),entry(2)]);throttled.queue.tick(options,async()=>{await throttled.clock.wait(1000);return '譯文'},true);await flush();assert.equal(throttled.queue.inFlight,1)
 const retry=setup([entry(1)]);const attemptTimes=[];const fail=async()=>{attemptTimes.push(retry.clock.now);throw new Error('temporary')}
 retry.queue.tick(options,fail);await flush();await retry.clock.advance(999);retry.queue.tick(options,fail);await flush();assert.equal(attemptTimes.length,1)
 await retry.clock.advance(1000);retry.queue.tick(options,fail);await flush();await retry.clock.advance(2999);retry.queue.tick(options,fail);await flush();assert.equal(attemptTimes.length,2)
 await retry.clock.advance(3000);retry.queue.tick(options,fail);await flush();assert.deepEqual(attemptTimes,[0,1000,3000]);assert.equal(retry.entries[0].translationStatus,'failed');assert.equal(retry.queue.retryCount,0)
 const blank=setup([entry(1)]);blank.queue.tick(options,async()=> '  ');await flush();assert.equal(blank.entries[0].translationAttempts,1)
 const rate=setup([entry(1)]);let rateCalls=0;const limited=async()=>{if(++rateCalls===1)throw new HttpServiceError('limit',429,15);return '譯文'}
 rate.queue.tick(options,limited);await flush();assert.equal(rate.entries[0].translationAttempts,undefined);await rate.clock.advance(14999);rate.queue.tick(options,limited);await flush();assert.equal(rateCalls,1)
 await rate.clock.advance(15000);rate.queue.tick(options,limited);await flush();assert.equal(rate.entries[0].translatedText,'譯文')
 const speaker=setup([entry(1)]);speaker.queue.tick(options,async()=>{await speaker.clock.wait(1000);return '譯文'});await flush();speaker.update(es=>assignSpeakersByOverlap(es,[{startMs:0,endMs:1200,speaker:'SPEAKER_00'}]));await speaker.clock.advance(1000);assert.equal(speaker.entries[0].translatedText,'譯文');assert.equal(speaker.queue.diagnostics.requests,1)
 const merge=setup([entry(1)]);merge.queue.tick(options,async()=>{await merge.clock.wait(1000);return '譯文'});await flush();merge.update(es=>upsertLiveCaption(es,entry(2,{startMs:1200,endMs:2400}),-1,id=>merge.queue.isActive(id)));assert.equal(merge.entries.length,2);await merge.clock.advance(1000);assert.equal(merge.entries[0].translatedText,'譯文')
 assert.equal(editCaptionContent(entry(1,{translatedText:'old'}),'new','old').translatedText,undefined);assert.equal(editCaptionContent(entry(1,{translatedText:'old'}),'new','manual').translatedText,'manual');
 const edit=setup([entry(1)]);edit.queue.tick(options,async()=>{await edit.clock.wait(1000);return '舊譯文'});await flush();edit.update(es=>es.map(e=>({...e,sourceText:'修改',translationContentRevision:1})));await edit.clock.advance(1000);assert.equal(edit.entries[0].translatedText,undefined);assert.equal(edit.queue.diagnostics.staleResults,1)
 const cancel=setup([entry(1),entry(2)]);cancel.queue.tick(options,async()=>{await cancel.clock.wait(2000);return 'late'});await flush();cancel.queue.reset(true);await flush();assert.equal(cancel.queue.inFlight,0);assert.ok(cancel.entries.every(e=>e.translationStatus==='failed'));await cancel.clock.advance(2000);assert.ok(cancel.entries.every(e=>!e.translatedText))
 cancel.queue.reset();cancel.update(()=>[entry(1,{sourceText:'新會話'})]);cancel.queue.tick(options,async()=> 'new');await flush();assert.equal(cancel.entries[0].translatedText,'new')
  const untouched=setup([entry(1)]);untouched.queue.tick({...options,targetLanguage:'zh-TW'},async()=>'不該被呼叫');await flush();assert.equal(untouched.queue.inFlight,0,'same-language captions are never dispatched');untouched.queue.reset(true);await flush();assert.equal(untouched.entries[0].translationStatus,undefined,'cancel must not report an attempt nothing made')
 const drain=setup([entry(1,{isSentenceBoundary:false})]);const draining=drain.queue.drain(options,async()=>{await drain.clock.wait(1000);return '尾句'});await drain.clock.advance(1200);assert.equal(await draining,true);assert.equal(drain.entries[0].translatedText,'尾句');assert.equal(drain.queue.inFlight,0)
 const manual=setup([entry(1),entry(2)]);const manualTransport=async()=>{await manual.clock.wait(1000);return '人工啟動的翻譯'};void manual.queue.request(manual.entries[0],manualTransport,'en');await flush();const manualDrain=manual.queue.drain(options,manualTransport,60000,false);await manual.clock.advance(1200);assert.equal(await manualDrain,true);assert.equal(manual.entries[0].translatedText,'人工啟動的翻譯');assert.equal(manual.entries[1].translatedText,undefined);assert.equal(manual.queue.diagnostics.requests,1)
 const settingsChange=setup([entry(1)]);settingsChange.queue.tick(options,async()=>{await settingsChange.clock.wait(2000);return 'old target'});await flush();settingsChange.queue.reset();await flush();settingsChange.queue.tick({...options,targetLanguage:'ja'},async()=> 'new target');await flush();await settingsChange.clock.advance(2000);assert.equal(settingsChange.entries[0].translatedText,'new target')
 const timing=setup([entry(1)]);timing.queue.tick(options,async()=>{await timing.clock.wait(1000);return '譯文'});await flush();timing.update(es=>es.map(e=>({...e,startMs:50,revision:e.revision+1})));await timing.clock.advance(1000);assert.equal(timing.entries[0].translatedText,'譯文')
 const deadline=setup([entry(1)]);const timeout=deadline.queue.drain(options,async()=>new Promise(()=>{}),1000);await deadline.clock.advance(1000);assert.equal(await timeout,false);await flush();assert.equal(deadline.queue.inFlight,0);assert.equal(deadline.entries[0].translationStatus,undefined)
 assert.equal(renderedLiveCaptionWindow(Array.from({length:10000},(_,i)=>entry(i))).length,500)
 assert.equal(renderedLiveCaptionWindow(Array.from({length:10000},(_,i)=>entry(i)),true).length,10000)
 // Runtime integration guards: pause scheduling before stop; save only after drain.
 const hook=readFileSync('src/renderer/src/features/app/hooks/useAppController.ts','utf8')
 const stop=hook.slice(hook.indexOf('const stopCapture ='),hook.indexOf('const exportTranscript ='))
 assert.ok(stop.indexOf('paused = true')<stop.indexOf('modelRef.current.stop()'))
 assert.ok(stop.indexOf('.drain(')<stop.indexOf('const finalSegments'))
 const stopClock=new Clock();global.window=stopClock.window();let aborted=0
 global.fetch=async(_url,init)=>{init.signal.addEventListener('abort',()=>aborted++);await stopClock.wait(1000);return response(200,{text:'尾段'})}
 const stopAdapter=new OpenAiChunkedModelAdapter({id:'test',endpoint:'/api/transcriptions',model:'mock',gatewayProfileId:'default'})
 const stoppedEvents=[];stopAdapter.onTranscript(e=>stoppedEvents.push(e));await stopAdapter.start({sampleRate:16000,language:'zh-TW',targetLanguage:'en'})
 const smallAudio=new Float32Array(1600).fill(.05)
 for(let i=0;i<4;i++)stopAdapter.enqueue(smallAudio,i*1600)
 stopAdapter.pendingChunks=[smallAudio];stopAdapter.pendingSamples=smallAudio.length;stopAdapter.pendingStart=6400;stopAdapter.pendingContainsSpeech=true
 await flush();const stopPromise=stopAdapter.stop();await stopClock.advance(6000);await stopPromise
 assert.equal(aborted,0,'normal stop must not abort healthy in-flight ASR');assert.equal(stoppedEvents.length,5,'full queue must drain before the final flush');assert.equal(stopAdapter.activeGatewayRequests.size,0)
 const bodyClock=new Clock();global.window=bodyClock.window()
 global.fetch=async(_url,init)=>({ok:true,status:200,headers:new Headers(),text:()=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError'))))})
 const bodyAdapter=new OpenAiChunkedModelAdapter({id:'test',endpoint:'/api/transcriptions',model:'mock',gatewayProfileId:'default'});bodyAdapter.gatewayTimeoutMs=1000
 await bodyAdapter.start({sampleRate:16000,language:'zh-TW',targetLanguage:'en'})
 const timedOut=assert.rejects(bodyAdapter.transcribeThroughWebGateway(new ArrayBuffer(44)),e=>e.name==='TimeoutError');await flush();await bodyClock.advance(1000);await timedOut;assert.equal(bodyAdapter.activeGatewayRequests.size,0)
 console.log('Caption lifecycle, limiter and scheduler regressions passed.')
}
async function virtualCapture(speed,inject=false){
 const h=setup();global.window=h.clock.window();const originalNow=Date.now;Date.now=()=>h.clock.now
 const quota=createRequestLimiter(requestLimits({}),()=>h.clock.now);let asrCalls=0,translationCalls=0,acceptedTranslations=0;const translatedIds=new Set(),latencies=[]
 global.fetch=async(url)=>{assert.equal(url,'/api/transcriptions');assert.ok(quota('test','transcriptions').accepted);asrCalls++;await h.clock.wait(300);return response(200,{text:`字幕${asrCalls}`,detectedLanguage:'zh-TW'})}
 let limitedOnce=false,failedOnce=false;const asrTexts=[]
 const translate=async(e)=>{
  translationCalls++;assert.ok(quota('test','translations').accepted)
  if(inject&&h.clock.now>=30000&&!limitedOnce){limitedOnce=true;throw new HttpServiceError('limit',429,15)}
  if(inject&&h.clock.now>=90000&&!failedOnce){failedOnce=true;throw new HttpServiceError('temporary',503)}
  assert.equal(translatedIds.has(e.id),false,'no unnecessary duplicate model request');translatedIds.add(e.id);acceptedTranslations++
  await h.clock.wait(100);latencies.push({at:e.endMs,lag:h.clock.now-e.endMs});return '譯文'
 }
 const adapter=new OpenAiChunkedModelAdapter({id:'test',endpoint:'/api/transcriptions',model:'mock',gatewayProfileId:'default',vadConfig:speedToVadConfig(speed)})
 adapter.onTranscript(e=>{if(e.status==='final')asrTexts.push(e.sourceText);h.update(es=>upsertLiveCaption(es,e,-1,id=>h.queue.isActive(id)))})
 await adapter.start({sampleRate:16000,language:'zh-TW',targetLanguage:'en'})
 const opts=()=>({...options,elapsedMs:h.clock.now})
 const timer=h.clock.timer(()=>h.queue.tick(opts(),translate),220,220)
 const audio=Float32Array.from({length:320},(_,i)=>.05*Math.sin(2*Math.PI*180*i/16000))
 let offset=0
 try {
  for(let ms=0;ms<600000;ms+=20){await h.clock.advance(ms);adapter.pushAudio(audio,offset);offset+=320}
  h.clock.tasks.delete(timer);h.queue.paused=true
  const stopping=adapter.stop();await h.clock.advance(604000);await stopping
  const draining=h.queue.drain(opts(),translate);await h.clock.advance(610000);assert.equal(await draining,true)
  assert.equal(h.entries.filter(e=>e.status==='gap').length,0);assert.ok(h.entries.every(e=>e.translatedText));assert.equal(h.entries.map(e=>e.sourceText).join(''),asrTexts.join(''),'merging must preserve all ASR content');assert.equal(h.queue.retryCount,0);assert.equal(h.queue.inFlight,0)
  assert.equal(adapter.diagnostics.inFlight,0);assert.equal(adapter.queuedChunks,0);assert.equal(adapter.pendingSamples,0);assert.equal(adapter.activeGatewayRequests.size,0)
  const report={speed,injectedFaults:inject,asrCalls,translationCalls,acceptedTranslations,captions:h.entries.length,asr:adapter.diagnostics,translation:h.queue.diagnostics,untranslated:0,gaps:0}
  console.log('10-minute virtual capture',JSON.stringify(report));return report
 }finally{Date.now=originalNow}
}
;(async()=>{await regressions();const results=[await virtualCapture('fast'),await virtualCapture('normal'),await virtualCapture('normal',true)];mkdirSync('experiment/evaluation-reports',{recursive:true});writeFileSync('experiment/evaluation-reports/caption-regression.json',JSON.stringify({passed:true,externalApiCalls:0,results},null,2)+'\n')})().catch(error=>{console.error(error);process.exitCode=1})
