const fs=require('node:fs'),path=require('node:path'),{buildSync}=require('esbuild')
const code=buildSync({entryPoints:['src/renderer/src/features/models/model-adapter.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {OpenAiChunkedModelAdapter}=m.exports
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
class Clock{
 constructor(){this.now=0;this.id=0;this.tasks=new Map()}
 wait(ms){return new Promise(r=>this.timer(r,ms))}
 timer(fn,delay){const id=++this.id;this.tasks.set(id,{at:this.now+delay,fn});return id}
 async advance(to){await flush();while(true){let chosen;for(const pair of this.tasks)if(pair[1].at<=to&&(!chosen||pair[1].at<chosen[1].at))chosen=pair;if(!chosen)break;this.tasks.delete(chosen[0]);this.now=chosen[1].at;chosen[1].fn();await flush()}this.now=to;await flush()}
}
;(async()=>{
 const clock=new Clock(),events=[],requests=[];let n=0
 global.window={setTimeout:(f,d)=>clock.timer(f,d),clearTimeout:id=>clock.tasks.delete(id),s2t:{transcribeAudioChunk:async p=>{const i=++n;requests.push({samples:(p.audio.byteLength-44)/2,startedAt:clock.now});await clock.wait(i===1?12000:400);return{text:'mock segment '+i}}}}
 const a=new OpenAiChunkedModelAdapter({id:'probe',endpoint:'http://mock/v1',model:'mock',requiresApiKey:false,vadConfig:{minSpeechMs:120,minSilenceMs:250,preRollMs:300,noiseFloorOffsetDb:12,chunkMinMs:700,chunkMaxMs:1500}})
 a.onTranscript(e=>events.push(e));await a.start({sampleRate:16000,language:'zh-TW',targetLanguage:'en'})
 for(let offset=0;offset<16000*45;offset+=160){a.pushAudio(Float32Array.from({length:160},(_,i)=>.05*Math.sin(2*Math.PI*180*(offset+i)/16000)),offset);await clock.advance((offset+160)/16)}
 const stop=a.stop();await clock.advance(120000);await stop
 const result={phase:process.argv[2]||'baseline',sampleRate:16000,totalSamples:16000*45,sentSamples:requests.reduce((s,r)=>s+r.samples,0),requests:requests.length,gaps:events.filter(e=>e.status==='gap'),events:events.map(e=>({startMs:e.startMs,endMs:e.endMs,status:e.status})),diagnostics:a.diagnostics}
 fs.writeFileSync(path.join(__dirname,'results',result.phase+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({phase:result.phase,totalSamples:result.totalSamples,sentSamples:result.sentSamples,gaps:result.gaps.length}))
})().catch(e=>{console.error(e);process.exitCode=1})
