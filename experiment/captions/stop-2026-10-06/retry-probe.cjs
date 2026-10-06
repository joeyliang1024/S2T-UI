const fs=require('node:fs'),path=require('node:path'),{buildSync}=require('esbuild')
const code=buildSync({entryPoints:['src/renderer/src/features/models/model-adapter.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
;(async()=>{
 let now=0,calls=0,id=0;const timers=new Map(),flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
 global.window={setTimeout:(f,d)=>{const n=++id;timers.set(n,{at:now+d,f});return n},clearTimeout:n=>timers.delete(n)}
 global.fetch=async()=>{calls++;return new Response(JSON.stringify({error:'invalid model selection'}),{status:400,headers:{'content-type':'application/json'}})}
 const a=new m.exports.OpenAiChunkedModelAdapter({id:'bad',endpoint:'/api/transcriptions',model:'bad',gatewayProfileId:'default'})
 await a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
 let error;const request=a.transcribeWithRetry(new ArrayBuffer(44)).catch(e=>error=e.message)
 await flush();while(timers.size){let next;for(const p of timers)if(!next||p[1].at<next[1].at)next=p;timers.delete(next[0]);now=next[1].at;next[1].f();await flush()}
 await request;await a.stop();const result={phase:process.argv[2]||'baseline',status:400,calls,retryDelayMs:now,error}
 fs.writeFileSync(path.join(__dirname,'results','retry-'+result.phase+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
})().catch(e=>{console.error(e);process.exitCode=1})
