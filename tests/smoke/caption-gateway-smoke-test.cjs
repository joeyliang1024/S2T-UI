const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const sleep = ms => new Promise(r => setTimeout(r,ms))
const main = async () => {
 const dir = await mkdtemp(join(tmpdir(),'s2t-caption-gateway-'))
 let upstreamStatus=200, upstreamCalls=0
 const mock=createServer(async(req,res)=>{for await(const ignored of req)void ignored;upstreamCalls++;res.setHeader('content-type','application/json');res.statusCode=upstreamStatus;if(upstreamStatus===429){res.setHeader('retry-after','15');res.end(JSON.stringify({error:{message:'Local test rate limit',type:'rate_limit_error'}}))}else res.end(JSON.stringify(req.url.includes('transcriptions')?{text:'字幕',language:'zh'}:{choices:[{message:{content:'translation'}}]}))})
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve))
 const endpoint=`http://127.0.0.1:${mock.address().port}/v1`
 const port=20000+Math.floor(Math.random()*15000)
 // Run from a fresh directory with a minimal environment: no project .env,
 // real credentials, external endpoints or production storage can be loaded.
 const child=spawn(process.execPath,[resolve('server/index.cjs')],{cwd:dir,env:{PATH:process.env.PATH,S2T_PROCESS_ROLE:'api',S2T_WEB_PORT:String(port),S2T_LOCAL_DATA_DIR:dir,S2T_AUTH_SECRET:'isolated-local-caption-test-secret',S2T_ASR_ENDPOINT:endpoint,S2T_ASR_MODEL:'mock',S2T_ASR_API_KEY:'local-test-key',S2T_TRANSLATION_ENDPOINT:endpoint,S2T_TRANSLATION_MODEL:'mock',S2T_TRANSLATION_API_KEY:'local-test-key',S2T_ASR_REQUESTS_PER_MINUTE:'4',S2T_TRANSLATION_REQUESTS_PER_MINUTE:'4',S2T_LOG_LEVEL:'error'},stdio:['ignore','pipe','pipe']})
 let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
 const base=`http://127.0.0.1:${port}`
 const request=async(path,init={})=>{const r=await fetch(base+path,init);return {r,body:await r.json().catch(()=>null)}}
 try {
  let ready=false;for(let i=0;i<100;i++){try{const r=await request('/readyz');if(r.r.status===200){ready=true;break}}catch{}await sleep(100)}assert.ok(ready,output)
  const register=async(name)=>{const x=await request('/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:'local-test-password',NT:name,Department:'test'})});assert.equal(x.r.status,201);return x.body.token}
  const a=await register('local-caption-a'),b=await register('local-caption-b')
  const translation=token=>request('/api/translations',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({text:'測試',sourceLanguage:'zh-TW',targetLanguage:'en'})})
  for(let i=0;i<4;i++)assert.equal((await translation(a)).r.status,200)
  const before=upstreamCalls;let result=await translation(a);assert.equal(result.r.status,429);assert.equal(upstreamCalls,before,'gateway quota must stop before the model');assert.ok(Number(result.r.headers.get('retry-after'))>0)
  assert.equal((await translation(b)).r.status,200,'same IP, different account must have independent quota')
  upstreamStatus=429
  const upstreamBefore429=upstreamCalls;result=await translation(b);assert.equal(upstreamCalls-upstreamBefore429,1,'SDK must not retry upstream 429 behind the scheduler');assert.equal(result.r.status,429);assert.equal(result.body.retryAfterSeconds,15);assert.equal(result.r.headers.get('retry-after'),'15')
  const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40)
  result=await request('/api/transcriptions',{method:'POST',headers:{authorization:`Bearer ${b}`,'content-type':'audio/wav'},body:wav});assert.equal(result.r.status,429);assert.equal(result.body.retryAfterSeconds,15)
  console.log('Isolated gateway HTTP smoke passed: per-account quotas and upstream 429 propagation. External API calls: 0.')
 }finally{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
