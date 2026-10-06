const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
let browser
;(async()=>{
 const source=buildSync({entryPoints:['src/renderer/src/features/models/model-adapter.ts'],bundle:true,platform:'browser',format:'iife',globalName:'CaptureProbe',write:false}).outputFiles[0].text
 const username=fs.readFileSync('experiment/k8s-large-history-2026-10-06/results/browser-username.txt','utf8').trim(),origin='http://127.0.0.1:8790'
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 const context=await browser.newContext(),page=await context.newPage(),requests=[]
 const login=await context.request.post(origin+'/api/auth/login',{data:{username,password:'large-history-test-only'}});assert.equal(login.status(),200)
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
 await page.route('**/api/transcriptions',async route=>{
  const request=route.request();requests.push({key:request.headers()['x-s2t-idempotency-key'],language:request.headers()['x-s2t-language'],bytes:request.postDataBuffer()?.length})
  const response=await route.fetch();assert.equal(response.status(),200)
  if(requests.length===1)await route.abort('failed')
  else await route.fulfill({response})
 })
 await page.goto(origin+'/',{waitUntil:'networkidle'});await page.addScriptTag({content:source})
 const result=await page.evaluate(async()=>{
  const a=new CaptureProbe.OpenAiChunkedModelAdapter({id:'browser-retry',endpoint:'/api/transcriptions',model:'mock-asr',gatewayProfileId:'default'})
  await a.start({sampleRate:16000,language:'en',targetLanguage:'zh-TW'})
  const audio=new ArrayBuffer(48044),v=new DataView(audio),write=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i))}
  write(0,'RIFF');v.setUint32(4,48036,true);write(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,48000,true)
  const response=await a.transcribeWithRetry(audio);await a.stop();return{text:response.text,diagnostics:a.diagnostics}
 })
 assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.ok(result.text)
 const output={passed:true,simulatedLostResponse:true,requests,result}
 fs.writeFileSync(path.join(__dirname,'results/browser-retry.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({passed:true,requests:requests.length,sameKey:true,textReturned:true}))
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close()})
