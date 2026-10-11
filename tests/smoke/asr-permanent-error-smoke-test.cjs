const assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const code=buildSync({entryPoints:['src/renderer/src/features/models/model-adapter.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {OpenAiChunkedModelAdapter}=m.exports
;(async()=>{
 for(const status of [400,401,403,404,405,410,413,415,422]){
  let calls=0,delays=[]
  global.window={setTimeout,clearTimeout};global.fetch=async()=>{calls++;return new Response(JSON.stringify({error:'permanent'}),{status,headers:{'content-type':'application/json'}})}
  const a=new OpenAiChunkedModelAdapter({id:'invalid',endpoint:'/api/transcriptions',model:'mock',gatewayProfileId:'default'})
  await a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
  await assert.rejects(a.transcribeWithRetry(new ArrayBuffer(44)),e=>e.status===status)
  assert.equal(calls,1);await a.stop()
 }
 for(const status of [408,409,425,502,503,504]){
  let calls=0,keys=[]
  global.fetch=async(_u,init)=>{calls++;keys.push(init.headers['x-s2t-idempotency-key']);return new Response(JSON.stringify(calls===1?{error:'temporary'}:{text:'recovered'}),{status:calls===1?status:200,headers:{'content-type':'application/json'}})}
  const a=new OpenAiChunkedModelAdapter({id:'transient',endpoint:'/api/transcriptions',model:'mock',gatewayProfileId:'default'})
  await a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
  assert.equal((await a.transcribeWithRetry(new ArrayBuffer(44))).text,'recovered');assert.equal(calls,2);assert.equal(keys[0],keys[1]);await a.stop()
 }
 console.log('PASS permanent 4xx fail once, transient errors recover with the same idempotency key')
})().catch(e=>{console.error(e);process.exitCode=1})
