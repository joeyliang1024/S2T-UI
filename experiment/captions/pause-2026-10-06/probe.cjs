const fs=require('node:fs'),path=require('node:path'),{buildSync}=require('esbuild')
const code=buildSync({entryPoints:['src/renderer/src/features/models/model-adapter.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
;(async()=>{
 const events=[],requests=[];global.window={setTimeout,clearTimeout,s2t:{transcribeAudioChunk:async r=>{requests.push(r);await new Promise(r=>setTimeout(r,30));return{text:'pause tail'}}}}
 const a=new m.exports.OpenAiChunkedModelAdapter({id:'pause',endpoint:'http://mock',model:'mock',requiresApiKey:false,vadConfig:{minSpeechMs:120,minSilenceMs:250,preRollMs:300,noiseFloorOffsetDb:12,chunkMinMs:700,chunkMaxMs:1500}})
 a.onTranscript(e=>events.push(e));await a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
 for(let offset=0;offset<9600;offset+=160)a.pushAudio(new Float32Array(160).fill(.05),offset)
 if(process.argv[2]==='fixed')a.flush()
 await new Promise(r=>setTimeout(r,100))
 const result={phase:process.argv[2]||'baseline',capturedSamples:9600,requestsBeforeResume:requests.length,captionsBeforeResume:events.length,closed:events[0]?.isSentenceBoundary||false}
 await a.stop();result.totalSentSamples=requests.reduce((s,r)=>s+(r.audio.byteLength-44)/2,0)
 fs.writeFileSync(path.join(__dirname,'results',result.phase+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
})().catch(e=>{console.error(e);process.exitCode=1})
