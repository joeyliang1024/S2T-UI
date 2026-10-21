const { createServer, request: httpRequest, Agent } = require('node:http')
const { build } = require('esbuild')
const { mkdir, writeFile } = require('node:fs/promises')
const { dirname, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { chromium, browserOptions } = require('../../../tests/helpers/browser.cjs')
const seconds = Number(process.env.S2T_PROBE_SECONDS || 600)
const upstream = process.env.S2T_PROBE_GATEWAY || 'http://127.0.0.1:18787'
if (!['127.0.0.1','localhost'].includes(new URL(upstream).hostname)) throw new Error('Probe requires an explicitly port-forwarded local test Gateway')
const reportPath = resolve(process.env.S2T_PROBE_REPORT || 'experiment/evaluation-reports/k8s-browser-500.json')
let browser, server
;(async () => {
  const bundle = (await build({ entryPoints: ['tests/fixtures/performance-k8s-browser.jsx'], bundle: true, platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text
  const agent = new Agent({ keepAlive: true, maxSockets: 8 })
  server = createServer((request, response) => {
    if (request.url === '/') { response.setHeader('content-type','text/html'); return response.end(`<html><head><style>body{font:12px sans-serif}article p{margin:1px}article{margin:3px}</style></head><body><div id="root"></div><script>window.probeSeconds=${seconds};window.probeExpectedStartAt=${Number(process.env.S2T_PROBE_START_AT || 0)}</script><script src="/bundle.js"></script></body></html>`) }
    if (request.url === '/bundle.js') { response.setHeader('content-type','text/javascript'); return response.end(bundle) }
    if (!request.url.startsWith('/api/')) { response.statusCode=404; return response.end() }
    const headers = { ...request.headers, host: new URL(upstream).host }; delete headers.origin
    const proxy = httpRequest(new URL(request.url, upstream), { method: request.method, headers, agent }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    proxy.on('error', error => { if (!response.headersSent) response.writeHead(502, {'content-type':'application/json'}); response.end(JSON.stringify({error:error.message})) })
    request.pipe(proxy)
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch(browserOptions({args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']}))
  const context = await browser.newContext({ viewport: { width:1280,height:1000 } }), page = await context.newPage()
  const id = 'probe-' + randomUUID().slice(0,12)
  const registration = await context.request.post(origin+'/api/auth/register',{data:{username:id,password:randomUUID(),NT:id,Department:'performance'}})
  if (registration.status()!==201) throw Error(`Probe registration failed: ${registration.status()}`)
  const samples = [], browserErrors = [], httpFailures = [], telemetryResponses = []
  page.on('pageerror',error => browserErrors.push(error.message))
  page.on('requestfailed',request => httpFailures.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText,at:new Date().toISOString()}))
  page.on('response',response => {if(new URL(response.url()).pathname==='/api/telemetry/captions')telemetryResponses.push({status:response.status(),at:new Date().toISOString()})})
  page.on('request',request => {if(new URL(request.url()).pathname==='/api/telemetry/captions')samples.push(...(request.postDataJSON().samples || []))})
  await page.goto(origin); await page.waitForFunction(()=>window.probeReady)
  console.log(JSON.stringify({event:'browser_probe_started',seconds,origin}))
  if (process.env.S2T_PROBE_START_AT) await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(process.env.S2T_PROBE_START_AT)-Date.now())))
  await page.evaluate(()=>{void window.startProbe().catch(error=>window.probeResult={error:String(error)})})
  await page.waitForFunction(()=>window.probeResult,null,{timeout:(seconds+120)*1000})
  const result = await page.evaluate(()=>window.probeResult)
  const stages = Object.fromEntries(['e2e_asr','e2e_translation','t5_network','t7_network','t5_paint','t7_paint'].map(stage=>{
    const values=samples.filter(x=>x.stage===stage).map(x=>x.seconds*1000).sort((a,b)=>a-b)
    const q=p=>values.length?values[Math.ceil(values.length*p)-1]:null
    return [stage,{count:values.length,p50Ms:q(.5),p90Ms:q(.9),p95Ms:q(.95),p99Ms:q(.99),maxMs:values.at(-1)??null,over3s:values.filter(x=>x>=3000).length}]
  }))
  const p90LatencyPassed = ['e2e_asr','e2e_translation'].every(stage => stages[stage].p90Ms !== null && stages[stage].p90Ms < 3000)
  const probeHealthy = result.synchronizationValid === true && !result.error && !(result.errors?.length) && !browserErrors.length && !httpFailures.length && stages.e2e_asr.count > 0 && stages.e2e_translation.count > 0
  const acceptance = {percentile:90,thresholdMs:3000,p90LatencyPassed,probeHealthy,acceptance10mComplete:seconds===600 && probeHealthy,scope:'One synchronized browser probe; verify configured-user HTTP success and dropped work separately'}
  await mkdir(dirname(reportPath),{recursive:true}); await writeFile(reportPath,JSON.stringify({...result,stages,acceptance,browserErrors,httpFailures,telemetryResponses,samples},null,2)+'\n')
  console.log(JSON.stringify({event:'browser_probe_completed',...result,stages,acceptance,browserErrors,httpFailures,telemetryResponses,reportPath}))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve())})
