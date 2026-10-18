const assert=require('node:assert/strict'),{build}=require('esbuild');
;(async()=>{
const result=await build({entryPoints:['src/renderer/src/features/models/model-adapter.ts'],bundle:true,format:'cjs',platform:'node',write:false,plugins:[{name:'timing-capture',setup(build){build.onLoad({filter:/caption-metrics\.ts$/},()=>({contents:'export const recordCaptionEvent=()=>{};export const parseServerTiming=()=>undefined;export const attachCaptionTiming=(event,timing)=>globalThis.observedTimings.push({event,timing})',loader:'ts'}))}}]});
const m={exports:{}};new Function('module','exports','require',result.outputFiles[0].text)(m,m.exports,require);
 let clock=10000;const saved=global.performance;global.performance={now:()=>clock};global.observedTimings=[];
 global.window={s2t:{transcribeAudioChunk:async()=>{clock+=400;return{text:'visible chunk'}}}};
 try{
 const adapter=m.exports.createOpenAiChunkedModelAdapter({id:'test',model:'test',endpoint:'http://unused',requiresApiKey:false,vadConfig:{minSpeechMs:120,minSilenceMs:250,preRollMs:300,noiseFloorOffsetDb:12,chunkMinMs:700,chunkMaxMs:1500}});
 await adapter.start({sampleRate:16000,language:'en',targetLanguage:'en'});
 for(let offset=0;offset<96000;offset+=512){clock=10000+(offset+512)/16;adapter.pushAudio(Float32Array.from({length:512},(_,i)=>.1*Math.sin(2*Math.PI*180*(offset+i)/16000)),offset)}
 await adapter.stop();assert.ok(observedTimings.length>=4,'continuous speech must produce multiple measured chunks');
 for(let i=0;i<observedTimings.length;i++){
  const {timing:t}=observedTimings[i];assert.ok(t.chunkSpeechAt<=t.queuedAt);assert.ok(t.chunkSpeechAt<=t.chunkDetectedAt&&t.chunkDetectedAt<=t.queuedAt);
  // t1~t5 pipeline anchors: queue precedes the request, the response precedes cleanup.
  assert.ok(t.queuedAt<=t.dequeuedAt&&t.dequeuedAt<=t.requestAt&&t.requestAt<=t.responseAt&&t.responseAt<=t.postEndAt,'t1~t4 anchors must be monotonic');
  if(i)assert.ok(t.chunkSpeechAt>observedTimings[i-1].timing.chunkSpeechAt,'later chunks use their own audio start, not the utterance onset');
 }
 assert.ok(observedTimings.some(x=>x.timing.speechAt===undefined&&Number.isFinite(x.timing.chunkSpeechAt)),'chunks without new VAD onset are measured');
 assert.ok(observedTimings.every(x=>x.timing.server===undefined),'Electron telemetry path carries no Server-Timing split');
 const metrics=require('../../server/metrics.cjs');assert.ok(metrics.acceptCaptionSamples({samples:[{stage:'e2e_asr',seconds:2},{stage:'t2_segment',seconds:1.5}]}));
 assert.ok(metrics.render().includes('s2t_caption_stage_duration_seconds_count{stage="t2_segment",phase="t2"} 1'));
 assert.equal(metrics.acceptCaptionSamples({samples:[{stage:'t9_arbitrary',seconds:1}]}),false);
 console.log('PASS continuous chunks have distinct sample-clock origins including chunks without VAD onset; new metrics are bounded and separate');
 }finally{global.performance=saved}
})().catch(e=>{console.error(e);process.exitCode=1});
