const assert=require('node:assert/strict')
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os')
const {createServer}=require('node:http')
const {build}=require('esbuild')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
const option=(name,defaultValue)=>{const at=process.argv.indexOf(name);return at<0?defaultValue:process.argv[at+1]}
const duration=Number(option('--seconds','600'))*1000
const reportPath=path.resolve(option('--report','experiment/evaluation-reports/recording-browser-pressure.json'))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
;(async()=>{
 let browser,server,temporary
 const results=[],pageErrors={},network={requests:0,externalBlocked:0}
 try{
  temporary=await fs.mkdtemp(path.join(os.tmpdir(),'s2t-recording-stress-'))
  const hook=await fs.readFile('src/renderer/src/features/app/hooks/useAppController.ts','utf8')
  const start=hook.indexOf('liveCorrectionRunnerRef.current = async'),end=hook.indexOf('\nuseEffect(',start)
  const keys=['liveCorrectionAudioRef','activeModelSnapshotRef','isFloatingCaptionWindow','liveCorrectionBusyRef','captureState','liveCorrectionEpochRef','continuationTargetRef','transcriptsRef','liveCorrectionDoneRef','liveCorrectionFailuresRef','liveCorrectionRunnerRef','correctionGroups','captionGroupSignature','selectedModel','makeWav','applySentenceCorrection','transcribeCorrection','setTranscripts','setStatus','activeTranslate']
  const previewStart=hook.indexOf('          const maximumPreviewSamples ='),previewEnd=hook.indexOf('\n        }',previewStart)
  const generated=`export function installCorrection(ctx){const {${keys.join(',')}}=ctx;${hook.slice(start,end)}}\nexport function pushPreview(ctx,samples){const {sampleRateRef,liveDiarizationChunksRef,liveDiarizationHeadRef,liveDiarizationSamplesRef,liveDiarizationStartSampleRef}=ctx;liveDiarizationChunksRef.current.push(samples);${hook.slice(previewStart,previewEnd)}}`
  const bundle=await build({entryPoints:['tests/fixtures/recording-stress-browser.jsx'],bundle:true,format:'iife',platform:'browser',write:false,define:{'process.env.NODE_ENV':'"production"'},
   plugins:[{name:'production-hook-excerpts',setup(build){build.onResolve({filter:/recording-stress-production\.generated$/},()=>({path:'hook-excerpts',namespace:'hook-excerpts'}));build.onLoad({filter:/.*/,namespace:'hook-excerpts'},()=>({contents:generated,loader:'ts'}))}}]})
  const script=bundle.outputFiles[0].text
  const worklet=await fs.readFile('src/renderer/src/features/capture/audio-capture.worklet.js','utf8')
  let sequence=0
  server=createServer(async(request,response)=>{
   try{
    const url=new URL(request.url,'http://localhost')
    if(url.pathname==='/'){response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif}.transcript{height:70vh;overflow:auto}mark{background:#ffdf60}article{padding:4px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');return}
    if(url.pathname==='/fixture.js'){response.setHeader('content-type','text/javascript; charset=utf-8');response.end(script);return}
    if(url.pathname==='/capture.worklet.js'){response.setHeader('content-type','text/javascript; charset=utf-8');response.end(worklet);return}
    if(['/api/transcriptions','/api/correction'].includes(url.pathname)){
     for await(const chunk of request)void chunk
     network.requests++
     await sleep(url.pathname==='/api/transcriptions'?300:200)
     response.setHeader('content-type','application/json');response.end(JSON.stringify({text:url.pathname==='/api/transcriptions'?`這是第${++sequence}段錄音討論與成本。`:'這是錄音討論與效能。',detectedLanguage:'zh-TW'}));return
    }
    response.statusCode=404;response.end()
   }catch(error){response.statusCode=500;response.end(JSON.stringify({error:String(error)}))}
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const origin=`http://127.0.0.1:${server.address().port}`
  browser=await chromium.launch(browserOptions({args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--enable-precise-memory-info']}))
  const short=Math.min(duration,180000)
  const configs=[
   {name:'normal-48k',sampleRate:48000,durationMs:duration,delay:'none',expectPauses:false},
   {name:'normal-96k',sampleRate:96000,durationMs:duration,delay:'none',expectPauses:false},
   {name:'new-buffer-burst',sampleRate:48000,durationMs:short,delay:'burst',expectPauses:false},
   {name:'old-threshold-burst',sampleRate:48000,durationMs:short,delay:'burst',legacy:true,expectPauses:short>=35000},
   {name:'sustained-stall',sampleRate:48000,durationMs:Math.min(duration,150000),delay:'sustained',expectPauses:duration>=75000}
  ]
  const selectedConfigs=option('--only','') ? configs.filter(config=>config.name===option('--only','')) : configs
  const tasks=selectedConfigs.map(async config=>{
   const context=await browser.newContext()
   const page=await context.newPage();pageErrors[config.name]=[]
   page.on('pageerror',error=>pageErrors[config.name].push(error.message))
   await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(network.externalBlocked++,route.abort()))
   await page.addInitScript(config=>{window.stressConfig=config},config)
   await page.goto(origin)
   const started=Date.now();let result
   while(Date.now()-started<config.durationMs+120000){
    await sleep(20000)
    const snapshot=await page.evaluate(()=>({progress:window.stressProgress,result:window.stressResult}))
    console.log(JSON.stringify({scenario:config.name,...snapshot.progress,finished:Boolean(snapshot.result)}))
    if(snapshot.result){result=snapshot.result;break}
   }
   if(!result)result={...config,passed:false,fatal:'Timed out after duration plus 120 seconds'}
   result.pageErrors=pageErrors[config.name]
   if(result.pageErrors.length)result.passed=false
   results.push(result)
   console.log(JSON.stringify({completed:config.name,passed:result.passed,pauses:result.pauses,audioIntact:result.audioIntact,fatal:result.fatal}))
   await context.close()
  })
  await Promise.all(tasks)
  const report={createdAt:new Date().toISOString(),passed:results.every(result=>result.passed),browserVersion:browser.version(),parallelScenarios:configs.length,externalApiCalls:0,network,
   limitations:['Synthetic oscillator instead of a physical microphone','Local mock ASR/correction; production remote-upload backend is not exercised','Isolated browser profiles; not the user existing browser session','Five concurrent scenarios add load; this is a pressure test, not a measurement of ordinary single-tab resource use'],results}
  await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({report:reportPath,passed:report.passed,results:results.map(({name,passed,pauses,audioIntact,frameP95Ms,opfsWriteP95Ms})=>({name,passed,pauses,audioIntact,frameP95Ms,opfsWriteP95Ms}))}))
  if(!report.passed)process.exitCode=1

 }finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));if(temporary)await fs.rm(temporary,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1})
