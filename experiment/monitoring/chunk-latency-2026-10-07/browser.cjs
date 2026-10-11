const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
let browser,tempDir
;(async()=>{
 const dir=tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'s2t-metrics-')),file=path.join(dir,'tone.wav'),wav=Buffer.alloc(44+16000*120*2)
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
 for(let i=44;i<wav.length;i+=2){const sample=(i-44)/2;wav.writeInt16LE(sample%128000<96000?Math.round(5000*Math.sin(2*Math.PI*180*sample/16000)):0,i)}fs.writeFileSync(file,wav)
 const origin=process.env.S2T_BROWSER_TEST_ORIGIN||'http://127.0.0.1:8790'
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+file]})
 const results=await Promise.all(Array.from({length:8},async(_,i)=>{
  const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage(),samples=[],events=[],errors=[],statuses=[];let telemetryActive=0,telemetryPeak=0,telemetryRequests=0,interceptorActive=0,interceptorPeak=0;const outstanding=new Set()
  const username='metricsbrowser'+Date.now()+i,r=await context.request.post(origin+'/api/auth/register',{data:{username,password:'metrics-browser-test-only',NT:username,Department:'Lab'}});assert.equal(r.status(),201)
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
  await page.route('**/api/telemetry/captions',async route=>{
   interceptorActive++;interceptorPeak=Math.max(interceptorPeak,interceptorActive)
   try{const response=await route.fetch();statuses.push(response.status());await route.fulfill({response})}finally{interceptorActive--}
  })
  page.on('request',request=>{if(request.url().endsWith('/api/telemetry/captions')){outstanding.add(request);telemetryActive++;telemetryPeak=Math.max(telemetryPeak,telemetryActive);telemetryRequests++;const body=request.postDataJSON();samples.push(...body.samples);events.push(body.events)}})
  const completed=event=>{const request=typeof event.request==='function'?event.request():event;if(outstanding.delete(request))telemetryActive--}
  page.on('response',completed);page.on('requestfailed',completed)
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(origin+'/',{waitUntil:'networkidle'});await page.locator('.live-controls-trigger').click()
  await page.locator('#live-sidebar-capture label').filter({hasText:/麥克風|Microphone/}).locator('select').first().selectOption('default')
  await page.getByRole('button',{name:/開始收音|Start recording/}).click();await page.getByRole('button',{name:/暫停|Pause/}).waitFor();await page.waitForTimeout(Number(process.env.S2T_CAPTURE_MS||10000))
  // If the page auto-paused (e.g., staging backpressure under load), capture
  // the status toast before it can fade, then resume recording before the
  // normal pause/stop sequence.
  const autoPaused=!await page.getByRole('button',{name:/暫停|Pause/}).isVisible()
  let pauseReason=null
  if(autoPaused){
   pauseReason=await page.locator('.status-toast').textContent().catch(()=>null)
   fs.writeFileSync(path.join(__dirname,'results/pre-pause-'+i+'.json'),JSON.stringify({samples,events,errors,statusToast:pauseReason,text:(await page.locator('body').innerText()).slice(-8000)},null,2))
   await page.getByRole('button',{name:/繼續|Resume/}).click({timeout:5000}).catch(()=>{});await page.waitForTimeout(2000)
  }
  await page.getByRole('button',{name:/暫停|Pause/}).click({timeout:10000}).catch(()=>{});await page.waitForTimeout(4000)
  await page.getByRole('button',{name:/停止|結束|Stop recording/}).click();await page.waitForTimeout(8000)
  const diagnostics={browser:i, samples,events,errors,statuses,telemetryPeak,telemetryRequests,interceptorPeak,autoPaused,pauseReason}
  if(errors.length||telemetryPeak!==1||statuses.some(status=>status!==200)) fs.writeFileSync(path.join(__dirname,'results/'+(process.env.S2T_TEST_PHASE||'chunk-browser')+'-failure-'+i+'.json'),JSON.stringify(diagnostics,null,2)+'\n')
  const first=samples.filter(s=>s.stage==='speech_to_first_paint');assert.ok(first.length>=2,'at least two detected speech onsets must actually paint');assert.ok(first.every(s=>s.seconds>0.12&&s.seconds<20))
  const stages=['vad_onset','chunk_wait','browser_queue','browser_preprocess','asr_roundtrip_with_retries','response_to_paint']
  const cohorts=samples.filter(s=>s.stage==='first_word_vad_onset').length
  assert.ok(cohorts>=2)
  for(const stage of stages)assert.equal(samples.filter(s=>s.stage==='first_word_'+stage).length,cohorts,'every slice must measure the same cohort')
  for(let n=0;n<samples.length;n++)if(samples[n].stage==='first_word_vad_onset'){
   const duration=samples.slice(n,n+6).reduce((total,s)=>total+s.seconds,0)
   assert.equal(samples[n-3].stage,'speech_to_first_paint')
   assert.ok(Math.abs(duration-samples[n-3].seconds)<1e-8,'six slices must sum to that exact first-word observation')
  }
  assert.equal(telemetryPeak,1,'slow monitoring must never create concurrent upload requests')
  assert.ok(statuses.every(status=>status===200))
  assert.equal(errors.length,0)
  const result={browser:i,samples,events,errors,statuses,telemetryPeak,telemetryRequests,interceptorPeak,autoPaused,pauseReason};await context.close();return result
 }))
 fs.writeFileSync(path.join(__dirname,'results/'+(process.env.S2T_TEST_PHASE||'chunk-browser')+'.json'),JSON.stringify(results,null,2)+'\n')
 const first=results.flatMap(r=>r.samples.filter(s=>s.stage==='chunk_speech_to_paint').map(s=>s.seconds)).sort((a,b)=>a-b),quantile=q=>first[Math.ceil(first.length*q)-1]
 console.log(JSON.stringify({passed:true,browsers:8,chunkPaintSamples:first.length,p50:quantile(.5),p95:quantile(.95),p99:quantile(.99)}))
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();if(tempDir)fs.rmSync(tempDir,{recursive:true,force:true})})
