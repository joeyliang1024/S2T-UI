const assert=require('node:assert/strict'),crypto=require('node:crypto'),{buildSync}=require('esbuild')
const code=buildSync({stdin:{contents:"export * from './src/renderer/src/features/models/model-adapter'; export * from './src/renderer/src/features/app/services/live-caption';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {OpenAiChunkedModelAdapter,upsertLiveCaption}=m.exports
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
class Clock{
 constructor(){this.now=0;this.id=0;this.tasks=new Map()}
 timer(fn,delay){const id=++this.id;this.tasks.set(id,{at:this.now+delay,fn});return id}
 wait(ms){return new Promise(r=>this.timer(r,ms))}
 async advance(to){await flush();while(true){let chosen;for(const p of this.tasks)if(p[1].at<=to&&(!chosen||p[1].at<chosen[1].at))chosen=p;if(!chosen)break;this.tasks.delete(chosen[0]);this.now=chosen[1].at;chosen[1].fn();await flush()}this.now=to;await flush()}
 window(){return{setTimeout:(f,d)=>this.timer(f,d),clearTimeout:id=>this.tasks.delete(id)}}
}
const profile=id=>({id,endpoint:'http://mock/v1',model:'mock',requiresApiKey:false,vadConfig:{minSpeechMs:120,minSilenceMs:250,preRollMs:300,noiseFloorOffsetDb:12,chunkMinMs:700,chunkMaxMs:1500}})
;(async()=>{
 const clock=new Clock(),hash=crypto.createHash('sha256'),streams=Array.from({length:100},()=>({samples:0,calls:0,hash:crypto.createHash('sha256'),events:[]}))
 global.window={...clock.window(),s2t:{transcribeAudioChunk:async r=>{const s=streams[Number(r.profileId)],view=new DataView(r.audio),pcm=Buffer.alloc(r.audio.byteLength-44);let bytes=0;s.samples+=(r.audio.byteLength-44)/2;s.calls++;for(let i=44;i<r.audio.byteLength;i+=2){const v=view.getInt16(i,true);if(v){pcm.writeInt16LE(v,bytes);bytes+=2}}s.hash.update(pcm.subarray(0,bytes));await clock.wait(s.calls===1?12000:400);return{text:'mock'}}}}
 const adapters=streams.map((s,i)=>{const a=new OpenAiChunkedModelAdapter(profile(String(i)));a.onTranscript(e=>s.events.push(e));return a})
 await Promise.all(adapters.map(a=>a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})))
 for(let offset=0;offset<16000*45;offset+=160){
  const frame=Float32Array.from({length:160},(_,i)=>.05*Math.sin(2*Math.PI*180*(offset+i)/16000)),pcm=Buffer.alloc(320);let bytes=0
  for(const v of frame){const p=(v<0?v*32768:v*32767)|0;if(p){pcm.writeInt16LE(p,bytes);bytes+=2}}
  hash.update(pcm.subarray(0,bytes));for(const a of adapters)a.pushAudio(frame,offset);await clock.advance((offset+160)/16)
 }
 const stop=Promise.all(adapters.map(a=>a.stop()));await clock.advance(150000);await stop
 const expected=hash.digest('hex')
 for(let i=0;i<100;i++){assert.equal(streams[i].samples,720000);assert.equal(streams[i].hash.digest('hex'),expected);assert.equal(streams[i].events.filter(e=>e.status==='gap').length,0);assert.ok(adapters[i].diagnostics.maximumQueued<=4);assert.ok(adapters[i].diagnostics.maximumPendingMs<=30000)}
 // A response lost after server commit must replay the same key and parameters.
 const retryClock=new Clock(),calls=[];global.window=retryClock.window()
 const web=new OpenAiChunkedModelAdapter({...profile('web'),gatewayProfileId:'default'})
 await web.start({sampleRate:16000,language:'zh-TW',targetLanguage:'en'})
 global.fetch=async(_url,init)=>{calls.push(init.headers);if(calls.length===1){web.updateLiveSettings({language:'en',prompt:'new prompt'});throw Error('response lost')}return new Response(JSON.stringify({text:'cached result'}),{status:200,headers:{'content-type':'application/json'}})}
 const request=web.transcribeWithRetry(new ArrayBuffer(44));await retryClock.advance(5000);await request
 assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]['x-s2t-language'],'zh')
 await web.stop()
 const endClock=new Clock();let entries=[],endCalls=0
 global.window={...endClock.window(),s2t:{transcribeAudioChunk:async()=>{const call=++endCalls;await endClock.wait(400);return{text:call===1?'recognized speech':''}}}}
 const endpoint=new OpenAiChunkedModelAdapter(profile('endpoint'))
 endpoint.onTranscript(e=>{entries=upsertLiveCaption(entries,e,-1,()=>false);if(!e.boundaryOnly&&e.sourceText)entries=entries.map(v=>({...v,sourceText:'manual edit',translatedText:'manual translation',speaker:'user speaker',revision:42}))})
 await endpoint.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
 for(let offset=0;offset<32000;offset+=160){endpoint.pushAudio(new Float32Array(160).fill(offset<22400?.05:0),offset);await endClock.advance((offset+160)/16)}
 const finish=endpoint.stop();await endClock.advance(10000);await finish
 assert.equal(entries.length,1);assert.equal(entries[0].isSentenceBoundary,true)
 assert.equal(entries[0].sourceText,'manual edit');assert.equal(entries[0].translatedText,'manual translation');assert.equal(entries[0].speaker,'user speaker');assert.equal(entries[0].revision,42)
 // An indefinitely slow provider cannot grow the unsent audio buffer forever.
 const boundClock=new Clock();global.window={...boundClock.window(),s2t:{transcribeAudioChunk:async r=>{assert.ok((r.audio.byteLength-44)/2<=16000*6,'stop clips remain bounded');await boundClock.wait(120000);return{text:'late'}}}}
 const bounded=new OpenAiChunkedModelAdapter(profile('bounded')),gapUpdates=[];bounded.onTranscript(e=>{if(e.status==='gap')gapUpdates.push(e)});await bounded.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
 for(let offset=0;offset<16000*50;offset+=160){bounded.pushAudio(new Float32Array(160).fill(.05),offset);await boundClock.advance((offset+160)/16)}
 assert.ok(bounded.pendingSamples<=16000*30);assert.ok(bounded.diagnostics.gaps>0)
 const drain=bounded.stop();await boundClock.advance(2000000);await drain
 assert.ok(gapUpdates.length<20,'overflow updates must not flood the UI at audio-frame frequency')
 assert.equal(new Set(gapUpdates.map(e=>e.id)).size,1)
 console.log('PASS 100 capture streams with 12s latency: all PCM retained in order, bounded queue/audio backlog, final drain stable retry fingerprint, empty-tail sentence closure and manual-edit preservation')
})().catch(e=>{console.error(e);process.exitCode=1})
