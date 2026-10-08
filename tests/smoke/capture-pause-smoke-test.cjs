const assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const code=buildSync({stdin:{contents:"export * from './src/renderer/src/features/models/model-adapter';export * from './src/renderer/src/features/app/services/live-caption';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {OpenAiChunkedModelAdapter,upsertLiveCaption}=m.exports,flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve()}
class Clock{constructor(){this.now=0;this.id=0;this.tasks=new Map()}timer(fn,d){const id=++this.id;this.tasks.set(id,{at:this.now+d,fn});return id}wait(d){return new Promise(r=>this.timer(r,d))}async advance(to){await flush();while(true){let next;for(const x of this.tasks)if(x[1].at<=to&&(!next||x[1].at<next[1].at))next=x;if(!next)break;this.tasks.delete(next[0]);this.now=next[1].at;next[1].fn();await flush()}this.now=to;await flush()}}
const profile={id:'pause',endpoint:'http://mock',model:'mock',requiresApiKey:false,vadConfig:{minSpeechMs:120,minSilenceMs:250,preRollMs:300,noiseFloorOffsetDb:12,chunkMinMs:700,chunkMaxMs:1500}}
;(async()=>{
 for(const duration of [600,1500,9000]){
  const clock=new Clock(),requests=[];let entries=[]
  global.window={setTimeout:(f,d)=>clock.timer(f,d),clearTimeout:id=>clock.tasks.delete(id),s2t:{transcribeAudioChunk:async r=>{requests.push((r.audio.byteLength-44)/2);await clock.wait(duration===9000&&requests.length===1?12000:400);return{text:'pause speech'}}}}
  const a=new OpenAiChunkedModelAdapter(profile);a.onTranscript(e=>entries=upsertLiveCaption(entries,e,-1,()=>false));await a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
  for(let offset=0;offset<duration*16;offset+=160){a.pushAudio(new Float32Array(160).fill(.05),offset);await clock.advance((offset+160)/16)}
  a.flush();a.flush();await clock.advance(duration+30000)
  assert.equal(requests.reduce((s,v)=>s+v,0),duration*16);assert.ok(entries.at(-1).isSentenceBoundary);assert.equal(a.stopped,false)
  const count=requests.length
  for(let offset=duration*16;offset<(duration+500)*16;offset+=160)a.pushAudio(new Float32Array(160).fill(.05),offset)
  const stop=a.stop();await clock.advance(duration+60000);await stop
  assert.equal(requests.length,count+1);assert.equal(requests.reduce((s,v)=>s+v,0),(duration+500)*16);assert.equal(a.explicitBoundaries.size,0)
 }
 const clock=new Clock();let calls=0
 global.window={setTimeout:(f,d)=>clock.timer(f,d),clearTimeout:id=>clock.tasks.delete(id),s2t:{transcribeAudioChunk:async()=>{calls++;return{text:'unexpected'}}}}
 const silent=new OpenAiChunkedModelAdapter(profile);await silent.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
 silent.pushAudio(new Float32Array(9600),0);silent.flush();await silent.stop();assert.equal(calls,0)
 console.log('PASS pause flush for short tails, exact chunk boundary and full slow queue; resume, idempotent flush, final drain and silent suppression')
})().catch(e=>{console.error(e);process.exitCode=1})
