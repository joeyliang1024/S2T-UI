const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
let browser
;(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s2t-stop-')),file=path.join(dir,'tone.wav'),wav=Buffer.alloc(44+16000*20*2)
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=44;i<wav.length;i+=2)wav.writeInt16LE(Math.round(5000*Math.sin(2*Math.PI*180*((i-44)/2)/16000)),i);fs.writeFileSync(file,wav)
 const origin='http://127.0.0.1:8790'
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+file]})
 const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage(),requests=[]
 const username='stopbrowser'+Date.now(),registered=await context.request.post(origin+'/api/auth/register',{data:{username,password:'stop-browser-test-only',NT:username,Department:'Lab'}});assert.equal(registered.status(),201)
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
 await page.route('**/api/transcriptions',async route=>{requests.push({at:Date.now(),bytes:route.request().postDataBuffer()?.length});await new Promise(r=>setTimeout(r,1200));await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'stop tail verified '+requests.length,detectedLanguage:'en-US'})})})
 await page.goto(origin+'/',{waitUntil:'networkidle'})
 await page.locator('.live-controls-trigger').click()
 const microphone=page.locator('#live-sidebar-capture label').filter({hasText:/麥克風|Microphone/}).locator('select').first();await microphone.selectOption('default')
 await page.getByRole('button',{name:/開始收音|Start recording/}).click()
 await page.getByRole('button',{name:/暫停|Pause/}).waitFor()
 await page.waitForTimeout(600)
 const before=requests.length,start=Date.now()
 await page.getByRole('button',{name:/停止|結束|Stop recording/}).click()
 let saved
 for(let i=0;i<100;i++){
  const response=await context.request.get(origin+'/api/data/sessions'),body=await response.json()
  if(body.sessions?.[0]?.processingState==='completed'){saved=body.sessions[0];break}
  await page.waitForTimeout(200)
 }
 assert.ok(saved,'recording must finish background processing')
 assert.equal(saved.segments.filter(s=>s.status==='final').length,requests.length)
 for(let i=1;i<=requests.length;i++)assert.ok(saved.segments.some(s=>s.sourceText==='stop tail verified '+i),'saved recording must include every late ASR response')
 const result={passed:true,requestsBeforeStop:before,totalRequests:requests.length,finalSegments:saved.segments.length,completedAfterMs:Date.now()-start,sourceTexts:saved.segments.map(s=>s.sourceText),requests}
 fs.writeFileSync(path.join(__dirname,'results/browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))

})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close()})
