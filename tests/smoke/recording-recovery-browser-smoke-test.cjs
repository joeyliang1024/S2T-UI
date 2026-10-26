// Production React hydration + OPFS manifests, with isolated loopback API fixtures.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{gunzipSync}=require('node:zlib'),{buildSync}=require('esbuild')
const {chromium,browserOptions}=require('../helpers/browser.cjs')
;(async()=>{
 const code=buildSync({stdin:{contents:"export * from './frontend/src/features/capture/recording/adapters/opfs-pcm-recording'; export * from './frontend/src/features/capture/recording/adapters/recovery-store';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'iife',globalName:'Recovery',platform:'browser',write:false}).outputFiles[0].text
 const root=path.resolve('out/web'),server=http.createServer((req,res)=>{if(req.url==='/seed'){res.setHeader('content-type','text/html');return res.end('<title>Recovery seed</title>')}let file=path.join(root,new URL(req.url,'http://fixture').pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(root,'index.html');res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch(browserOptions())
 let releaseAck;const ackGate=new Promise(resolve=>{releaseAck=resolve});let waiting=false,version=0,posts=0
 const sessions=[{id:'committed',title:'Already saved',createdAt:'2026-10-14T00:00:00Z',durationMs:1000,source:'fixture',transcript:'already saved',segments:[],audioKey:'committed',audioUnavailable:false,processingToken:'token-done',processingState:'completed'}],audio=new Map(),errors=[]
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/seed');await page.addScriptTag({content:code})
  await page.evaluate(async()=>{
   const make=async(id,owner='fixture-user')=>{const draft={id,startedAt:'2026-10-14T00:00:00Z',updatedAt:'2026-10-14T00:00:01Z',captureState:'paused',source:'fixture',elapsedMs:1000,sampleRate:16000,opfsRecordingId:'pcm-'+id,segments:[{id:'segment-'+id,revision:1,status:'final',startMs:0,endMs:1000,sourceText:'Captured '+id}]};const recording=await Recovery.OpfsPcmRecording.create('pcm-'+id,16000,{ownerId:owner,draft});await recording.append(new Uint8Array([1,2,3,4]).buffer);return recording}
   await make('one');await make('two');await make('foreign','other-user')
   const active = await Recovery.createRecordingRecoveryStore('fixture-user').inspect()
   if (active.entries.length) throw Error('active capture in another context must not be recovered')
   const completed=await make('done');await completed.setRecoveryTarget({sessionId:'committed',audioKey:'committed',processingToken:'token-done'})
   await make('corrupt');const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('s2t-ui-recordings');const file=await(await dir.getDirectoryHandle('pcm-corrupt.pcm')).getFileHandle('recovery.json');const writer=await file.createWritable();await writer.write(JSON.stringify({ownerId:'fixture-user'}));await writer.close()
  })
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url()),name=url.pathname,method=req.method();let response={},status=200
   if(name.startsWith('/api/data/audio/')){const key=decodeURIComponent(name.split('/').pop());if(method==='POST'){audio.set(key,req.postDataBuffer());return route.fulfill({status:200,body:'{}'})}return route.fulfill({status:audio.has(key)?200:404,contentType:'audio/wav',body:audio.get(key)||Buffer.alloc(0)})}
   let body={};if(method==='POST'&&req.postDataBuffer()){const bytes=req.headers()['content-encoding']==='gzip'?gunzipSync(req.postDataBuffer()):req.postDataBuffer();body=JSON.parse(bytes.toString())}
   if(name==='/api/auth/session')response={user:{id:'fixture-user',username:'fixture',role:'user',NT:'fixture',Department:'test',createdAt:'2026-10-14'}}
   else if(name==='/api/config')response={asr:{configured:false},translation:{configured:false},summary:{configured:false},diarization:{configured:false},asrProfiles:[]}
   else if(name==='/api/data/settings')response=method==='POST'?{version:1}:{settings:{uiLanguage:'en'},version:0}
   else if(name==='/api/data/sessions'){if(method==='POST'){posts++;waiting=true;await ackGate;if(body.version!==version){status=409;response={error:'HTTP 409'}}else{sessions.splice(0,sessions.length,...body.sessions);response={version:++version}}}else response={sessions,version}}
   else if(name==='/api/data/summary-templates')response={templates:[{id:'base',name:'Base',content:'# Summary'}],selectedTemplateId:'base',version:0}
   else if(name==='/api/data/model-registry')response={models:[],version:0}
   else if(name==='/api/data/voiceprints')response={voiceprints:[]}
   else if(name==='/api/data/storage-status')response={audioPending:0,voiceprintPending:0}
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(response)})
  })
  await page.goto(origin+'/history');await page.locator('.session-actions').first().waitFor()
  await assertEventually(()=>waiting,'session metadata write started')
  await page.addScriptTag({content:code})
  const before=await page.evaluate(async()=>{const value=await Recovery.createRecordingRecoveryStore('fixture-user').inspect();return{entries:value.entries.length,issues:value.issues.length}})
  assert.deepEqual(before,{entries:3,issues:1},'no owned source can disappear before session ACK');assert.equal(audio.size,2,'committed target is not re-uploaded or duplicated')
  releaseAck();await assertEventually(()=>sessions.length===3,'both recovered records committed')
  await page.waitForFunction(async()=>{const inspection=await Recovery.createRecordingRecoveryStore('fixture-user').inspect();return inspection.entries.length===0})
  assert.deepEqual(sessions.map(entry=>entry.id).sort(),['committed','recovery-live-one','recovery-live-two']);assert.equal(await page.locator('.session-actions').count(),3)
  const retained=await page.evaluate(async()=>({foreign:(await Recovery.createRecordingRecoveryStore('other-user').inspect()).entries.length,corrupt:(await Recovery.OpfsPcmRecording.recover('pcm-corrupt',16000)).size,issues:(await Recovery.createRecordingRecoveryStore('fixture-user').inspect()).issues.length}))
  assert.deepEqual(retained,{foreign:1,corrupt:48,issues:1})
  await page.reload();await page.locator('.session-actions').first().waitFor();await assertEventually(()=>posts>=1,'hydration complete');assert.equal(await page.locator('.session-actions').count(),3);assert.deepEqual(errors,[])
  console.log('PASS real React hydration: multiple owned OPFS recoveries, foreign/corrupt sources retained, exact committed target deduped, no cleanup before metadata ACK and no duplicates after reload')
 }finally{releaseAck();await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1})
async function assertEventually(check,label){const deadline=Date.now()+10000;while(!check()){if(Date.now()>deadline)throw Error(label);await new Promise(resolve=>setTimeout(resolve,20))}}
