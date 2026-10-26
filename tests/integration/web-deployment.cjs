// Opt-in checks against the isolated local K8s deployment; creates/removes one test account.
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
const { readEnv } = require('../../scripts/runtime.cjs')
const { request } = require('playwright')
const env = readEnv('backend/.env.k8s'), base = process.env.S2T_TEST_WEB_URL || 'http://127.0.0.1:5173'
if (process.env.S2T_ALLOW_DEPLOYMENT_TESTS !== 'true' || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw new Error('Use S2T_ALLOW_DEPLOYMENT_TESTS=true against a local isolated deployment')
const results = [], stamp = Date.now().toString(36), username = `webcheck-${stamp}`, password = `Web-check-${stamp}-password`
const fixture = resolve('tests/fixtures/speech-sample.wav'), audio = readFileSync(fixture)
let browser, userId, admin, failurePage
const step = (name, data = {}) => { results.push({ name, ...data }); console.log('PASS', name, JSON.stringify(data)) }
const check = async (context, method, path, options = {}, statuses = [200]) => {
 const r = await context[method](base + path, { timeout: 120000, ...options });
 assert.ok(statuses.includes(r.status()), `${method} ${path}: ${r.status()} ${(await r.text()).slice(0,500)}`)
 return r
}
;(async () => {
 admin = await request.newContext()
 for(let attempt=0;attempt<20;attempt++){
  try{const response=await admin.get(base+'/api/config',{timeout:3000});if(response.ok()){await new Promise(r=>setTimeout(r,500));break}}catch{}
  assert.ok(attempt<19,'frontend/API forwarding never became ready');await new Promise(r=>setTimeout(r,500))
 }
 await check(admin, 'post', '/api/auth/login', { data: { username: env.S2T_BOOTSTRAP_ADMIN_USERNAME, password: env.S2T_BOOTSTRAP_ADMIN_PASSWORD } })
 const created = await (await check(admin, 'post', '/api/admin/users', { data: { username, password, NT: username, Department: 'Web validation' } }, [201])).json()
 userId = created.user.id
 await check(admin, 'put', `/api/admin/users/${userId}/role`, { data: { role: 'developer' } })
 step('admin account creation and role update')
 browser = await chromium.launch(browserOptions({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`] }))
 const context = await browser.newContext({ locale: 'en-US', permissions: ['microphone'], viewport: { width: 1440, height: 1000 } })
 const browserBaseline = {}
 const deployment = { ...readEnv('deploy/k8s/.env'), ...process.env }
 const k = [...(deployment.K8S_CONTEXT ? ['--context',deployment.K8S_CONTEXT] : []),'-n',deployment.K8S_NAMESPACE || 's2t-web']
 const browserPods = JSON.parse(execFileSync('kubectl',[...k,'get','pods','-l','app=s2t-backend','-o','json'],{encoding:'utf8'})).items.filter(p=>!p.metadata.deletionTimestamp&&p.status.containerStatuses?.every(c=>c.ready)).map(p=>p.metadata.name)
 assert.equal(browserPods.length,2)
 for(const kind of ['count','sum']){
  const expr=`sum by(stage)(s2t_caption_stage_duration_seconds_${kind}{job="s2t",pod=~"${browserPods.join('|')}",stage=~"e2e_asr|e2e_translation_tail"})`
  let result
  for(let attempt=0;attempt<10;attempt++){
   try{result=await (await fetch('http://127.0.0.1:9090/api/v1/query?query='+encodeURIComponent(expr),{signal:AbortSignal.timeout(3000)})).json();assert.equal(result.status,'success');break}catch(error){if(attempt===9)throw error;await new Promise(r=>setTimeout(r,500))}
  }
  for(const value of result.data.result){browserBaseline[value.metric.stage]||={count:0,sum:0};browserBaseline[value.metric.stage][kind]=Number(value.value[1])}
 }
 const page = await context.newPage(), jsErrors = [], telemetry = []
 failurePage = page
 page.on('pageerror', e => jsErrors.push(e.message))
 page.on('response', r => { if(r.url().endsWith('/api/telemetry/captions')&&r.status()===200){const body=r.request().postDataJSON();telemetry.push(...(body.samples||[]))} })
 await page.goto(base)
 await page.locator('input[autocomplete="username"]').fill(username)
 await page.locator('input[type="password"]').fill(password)
 await page.locator('.auth-card button.primary').click()
 await page.locator('.sidebar-nav').first().waitFor({ state: 'attached', timeout: 30000 })
 const api = context.request
 assert.equal((await (await check(api, 'get', '/api/auth/session')).json()).user.id, userId)
 for (const view of ['history', 'models', 'settings', 'summary', 'import', 'voiceprints', 'live']) {
  const link = page.locator(`.sidebar-nav [data-view="${view}"]`)
  if (await link.count()) { await link.click(); await page.waitForTimeout(150) }
 }
 await page.reload(); await page.locator('.sidebar-nav').first().waitFor({ state: 'attached' })
 step('browser login, HttpOnly cookie, page navigation and reload')
 const cfg = await (await check(api, 'get', '/api/config')).json()
 assert.ok(cfg.capabilities.distributed && cfg.capabilities.durableRecordingChunks)
 let settings
 for (let attempt=0;attempt<8;attempt++) {
  settings = await (await check(api,'get','/api/data/settings')).json()
  const saved = await api.post(base+'/api/data/settings',{data:{settings:{...settings.settings,theme:'dark',translationEnabled:true,sourceLanguage:'en-US',targetLanguage:'zh-TW'},version:settings.version}})
  if(saved.status()===200) break
  assert.equal(saved.status(),409);assert.ok(attempt<7,'settings UI did not settle');await page.waitForTimeout(500)
 }
 await check(api,'post','/api/data/settings',{data:{settings:{theme:'light'},version:settings.version}},[409])
 const glossary = await (await check(api,'get','/api/data/glossary')).json()
 await check(api,'post','/api/data/glossary',{data:{glossary:'Kubernetes = K8s',version:glossary.version}})
 assert.ok((await (await check(api,'get','/api/data/summary-templates')).json()).templates.length)
 step('distributed config, settings CAS conflict, glossary and templates')
 const recording = `webcheck-${stamp}`, chunk = Buffer.from([1,0,2,0,3,0,4,0])
 for (const [i,start,bytes] of [[1,2,chunk.subarray(4)],[0,0,chunk.subarray(0,4)]]) await check(api,'put',`/api/data/recordings/${recording}/chunks/${i}`,{headers:{'x-s2t-start-sample':String(start),'x-s2t-sample-rate':'16000','content-type':'application/octet-stream'},data:bytes})
 await check(api,'post',`/api/data/recordings/${recording}/finish`,{data:{totalChunks:2,totalSamples:4}})
 const wav = await (await check(api,'get',`/api/data/audio/${recording}`)).body(); assert.deepEqual(wav.subarray(44),chunk)
 await check(api,'post',`/api/data/recordings/${recording}/promote`,{data:{audioKey:`permanent-${stamp}`}},[201])
 await check(api,'delete',`/api/data/recordings/${recording}`,{},[204])
 step('out-of-order durable chunks, final WAV, promotion and cleanup through Nginx/MinIO')
 const asrStart = performance.now()
 const asrResponse = await check(api,'post','/api/transcriptions',{headers:{'content-type':'audio/wav','x-s2t-idempotency-key':`webcheck-asr-${stamp}`},data:audio})
 const asr = await asrResponse.json(); assert.ok(asr.text)
 const asrMs = performance.now()-asrStart, timing = asrResponse.headers()['server-timing']; assert.match(timing,/model;dur=/)
 const repeated = await (await check(api,'post','/api/transcriptions',{headers:{'content-type':'audio/wav','x-s2t-idempotency-key':`webcheck-asr-${stamp}`},data:audio})).json(); assert.equal(repeated.text,asr.text)
 const translation = await (await check(api,'post','/api/translations',{data:{text:asr.text,sourceLanguage:'zh-TW',targetLanguage:'en'}})).json(); assert.ok(translation.text)
 const summary = await (await check(api,'post','/api/summaries',{data:{messages:[{role:'user',content:'Summarize the deployment test'}],stream:true}})).text(); assert.match(summary,/text|delta|done/)
 step('ASR, idempotent replay, translation and streamed summary',{asrRoundTripMs:Math.round(asrMs),serverTiming:timing,modelScope:'existing isolated mock service; not recognition accuracy'})
 const converted = await check(api,'post','/api/audio-processing/transcode?format=m4a',{headers:{'content-type':'audio/wav'},data:audio}); assert.ok((await converted.body()).length>100)
 const vad = await (await check(api,'post','/api/audio-processing/silero-vad',{headers:{'content-type':'audio/wav'},data:audio})).json(); assert.ok(vad.speech.length)
 const turns = await (await check(api,'post','/api/diarizations',{headers:{'content-type':'audio/wav'},data:audio})).json(); assert.ok(turns)
 step('real container FFmpeg, Silero and diarization audio path')
 const enroll = await (await check(api,'post','/api/voiceprints',{headers:{'content-type':'audio/wav','x-s2t-voiceprint-sharing':'private'},data:audio},[201])).json()
 assert.ok(enroll.voiceprint.id)
 const identified = await (await check(api,'post','/api/voiceprints/identify',{headers:{'content-type':'audio/wav'},data:audio})).json(); assert.ok(identified)
 await check(api,'delete',`/api/voiceprints/${enroll.voiceprint.id}`,{},[204])
 step('real speaker embedding, vector persistence, identification and deletion')
 await page.reload(); await page.locator('.sidebar-nav').first().waitFor({state:'attached'})
 await page.locator('.sidebar-nav [data-view="live"]').click()
 await page.evaluate(()=>{
  window.__validationToasts=[]
  new MutationObserver(()=>{const text=document.querySelector('.status-toast')?.textContent;if(text&&window.__validationToasts.at(-1)!==text)window.__validationToasts.push(text)}).observe(document.body,{subtree:true,childList:true,characterData:true})
 })
 const verifyCleanupReload = process.env.S2T_TEST_RECORDING_CLEANUP_RELOAD === 'true'
 let permitCleanup = !verifyCleanupReload, failedCleanupCalls = 0
 const liveCaptureIds = new Set()
 page.on('request', request => { const match = new URL(request.url()).pathname.match(/\/recordings\/(capture-[^/]+)\/chunks\//); if (match) liveCaptureIds.add(match[1]) })
 if (verifyCleanupReload) {
  await page.route('**/api/data/recordings/capture-*/finish', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'injected finalization outage' }) }))
  await page.route('**/api/data/recordings/capture-*/cleanup', async route => {
   if (!permitCleanup) { failedCleanupCalls++; await route.abort('failed') }
   else await route.continue()
  })
 }
 const uploadStallMs = Number(process.env.S2T_TEST_RECORDING_UPLOAD_STALL_MS || 0)
 assert.ok(Number.isFinite(uploadStallMs) && uploadStallMs >= 0 && uploadStallMs <= 120000, 'invalid upload fault duration')
 let blockedUploads = 0, committedLostAcks = 0, blockedUntil = Date.now() + uploadStallMs
 if (uploadStallMs) await page.route('**/api/data/recordings/*/chunks/*', async route => {
  if (Date.now() < blockedUntil) {
   blockedUploads++
   // Commit the first chunk to real storage but deliberately lose its ACK,
   // including the HTTP client's retries, while new local audio keeps arriving.
   if (committedLostAcks < 3) {
    const response = await route.fetch({ timeout: 30000 })
    assert.ok(response.ok(), 'durable upload failed before injected ACK loss')
    await response.dispose(); committedLostAcks++
   }
   await route.abort('failed')
  }
  else await route.continue()
 })
 await page.locator('.capture-controls button.primary').click()
 await page.locator('#microphone-setup').waitFor({state:'visible'})
 await page.locator('#microphone-setup button[type="submit"]').click()
 await page.locator('.capture-controls button.danger').waitFor({state:'visible',timeout:30000})
 if (uploadStallMs) {
  await page.waitForTimeout(uploadStallMs)
  const local = await page.evaluate(async () => {
   const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('s2t-ui-recordings')
   const sources = []
   for await (const [name, directory] of root.entries()) {
    if (!name.endsWith('.pcm')) continue
    const metadata = JSON.parse(await (await (await directory.getFileHandle('metadata.json')).getFile()).text())
    const recovery = JSON.parse(await (await (await directory.getFileHandle('recovery.json')).getFile()).text())
    let bytes = 0
    for await (const [part, handle] of directory.entries()) if (part.endsWith('.pcm.commit')) {
     const marker = JSON.parse(await (await handle.getFile()).text()); bytes += marker.bytes
    }
    sources.push({ bytes, sampleRate: metadata.sampleRate, captureState: recovery.draft.captureState })
   }
   return sources.sort((a,b)=>b.bytes-a.bytes)[0]
  })
  assert.ok(blockedUploads > 0, 'upload fault was not exercised')
  assert.equal(committedLostAcks, 3, 'lost durable ACK fault was not exercised')
  assert.ok(local && local.bytes / (local.sampleRate * 2) >= uploadStallMs / 1000 - 8, 'local recording stopped during upload outage')
  assert.equal(local.captureState, 'recording', 'capture paused due to network upload backpressure')
  assert.ok(telemetry.some(x=>x.stage==='e2e_asr') && telemetry.some(x=>x.stage==='e2e_translation_tail'), 'captions/translation stopped during upload outage')
  step('recording and captions continue through upload outage', { uploadStallMs, blockedUploads, committedLostAcks, localSeconds: local.bytes / (local.sampleRate * 2), captureState: local.captureState })
  blockedUntil = 0
  await page.waitForTimeout(18000)
 } else await page.waitForTimeout(15000)
 await page.locator('.capture-controls button.danger').click()
 await page.waitForTimeout(5000)
 let recorded
 for(let attempt=0;attempt<45;attempt++){
  const sessions=(await (await check(api,'get','/api/data/sessions')).json()).sessions
  recorded=sessions[0]
  if(recorded&&!['running','queued'].includes(recorded.processingState))break
  assert.ok(attempt<44,'background diarization did not complete');await page.waitForTimeout(1000)
 }
 assert.ok(recorded?.segments.some(x=>x.status==='final'&&x.sourceText))
 assert.ok(recorded.segments.some(x=>x.translatedText),'translated captions must be saved')
 assert.notEqual(recorded.processingState,'failed','saved record must complete its background stages')
 const savedAudio=await (await check(api,'get','/api/data/audio/'+recorded.audioKey)).body()
 assert.equal(savedAudio.toString('ascii',0,4),'RIFF');assert.ok(savedAudio.length>32000)
 step('saved transcript, translations, WAV and completed background stages',{processingState:recorded.processingState,audioBytes:savedAudio.length,segments:recorded.segments.length})
 if (verifyCleanupReload) {
  assert.equal(liveCaptureIds.size, 1)
  const captureId = [...liveCaptureIds][0]
  for (let attempt=0; attempt<40 && !failedCleanupCalls; attempt++) await page.waitForTimeout(250)
  assert.ok(failedCleanupCalls, 'cleanup outage was not exercised')
  const before = await (await check(api, 'get', '/api/data/recordings/'+captureId)).json()
  assert.equal(before.state, 'recording', 'test must exercise full-file fallback with an unfinished upload')
  const hasLocal = async () => page.evaluate(async id => {
   const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('s2t-ui-recordings')
   try { await root.getDirectoryHandle(id+'.pcm'); return true } catch (error) { if (error.name === 'NotFoundError') return false; throw error }
  }, captureId)
  assert.ok(await hasLocal(), 'failed remote cleanup must retain local recovery intent')
  permitCleanup = true
  await page.reload(); await page.locator('.sidebar-nav').first().waitFor({state:'attached'})
  for (let attempt=0; attempt<80 && await hasLocal(); attempt++) await page.waitForTimeout(250)
  assert.equal(await hasLocal(), false, 'reload recovery did not finish local cleanup')
  await check(api, 'get', '/api/data/recordings/'+captureId, {}, [404])
  await check(api, 'get', '/api/data/audio/'+captureId, {}, [404])
  assert.deepEqual(await (await check(api, 'get', '/api/data/audio/'+recorded.audioKey)).body(), savedAudio, 'cleanup changed the authoritative WAV')
  step('unfinished-upload fallback and cleanup survive reload', { failedCleanupCalls, remoteBackupRemoved: true, opfsRemoved: true, savedAudioUnchanged: true })
 }
 await page.screenshot({path:'/private/tmp/s2t-k8s-browser-validated.png',fullPage:true})
 assert.deepEqual(jsErrors,[])
 const measured = Object.fromEntries(['e2e_asr','e2e_translation_tail'].map(stage=>[stage,telemetry.filter(x=>x.stage===stage).map(x=>x.seconds)]))
 assert.ok(measured.e2e_asr.length,'real ASR paint samples must reach telemetry')
 assert.ok(measured.e2e_translation_tail.length,'real translated paint samples must reach telemetry')
 for(const values of Object.values(measured)) assert.ok(values.every(x=>Number.isFinite(x)&&x>=0&&x<120))
 step('real browser microphone capture, subtitle pipeline, stop and persisted history',{measuredSeconds:measured,browserBaseline,browserPods})
 await check(api,'post','/api/auth/logout',{},[204]); await check(api,'get','/api/auth/session',{},[401])
 step('logout revokes authenticated session')
})().catch(async e=>{ console.error(e.message); if(failurePage){console.error((await failurePage.locator('body').innerText()).slice(-6500));console.error('recording status:',await failurePage.evaluate(()=>window.__validationToasts));await failurePage.screenshot({path:'/private/tmp/s2t-k8s-browser-failure.png',fullPage:true})};process.exitCode=1 }).finally(async()=>{
 if (userId && admin) { try { await check(admin,'delete',`/api/admin/users/${userId}`,{},[200,204]) } catch(e){ console.error('test account cleanup:',e.message);process.exitCode=1 } }
 await browser?.close();await admin?.dispose()
 writeFileSync('/private/tmp/s2t-k8s-validation.json',JSON.stringify({passed:!process.exitCode,results},null,2)+'\n')
})
