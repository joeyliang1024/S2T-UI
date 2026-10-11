const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { build } = require('esbuild')
const { chromium } = require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 's2t-browser-metrics-'))
  let browser, child, output = ''
  const mock = createServer(async (req, res) => {
    for await (const ignored of req) void ignored
    await sleep(1200)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'local mock caption' }))
  })
  try {
    await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve) })
    const renderer = path.join(directory, 'out/renderer'); await fs.mkdir(renderer, { recursive: true })
    await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React, {useState, useLayoutEffect} from 'react'; import {createRoot} from 'react-dom/client';
      import {attachCaptionTiming, registerCaptionTiming, setCaptionMeasurementActive} from './src/renderer/src/shared/services/caption-metrics';
      import {CaptionPaintMetric} from './src/renderer/src/features/app/views/CaptionPaintMetric';
      let sequence=0;
      function App(){const [view,setView]=useState('live'),[entries,setEntries]=useState([]);
        useLayoutEffect(()=>{setCaptionMeasurementActive(view==='live');return ()=>setCaptionMeasurementActive(false)},[view]);
        window.testHarness={navigate:setView,begin:()=>{const id='test-'+(++sequence),start=performance.now();
          const bytes=new Uint8Array(44+3200);const d=new DataView(bytes.buffer);for(const [offset,text] of [[0,'RIFF'],[8,'WAVEfmt '],[36,'data']])for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);
          d.setUint32(4,bytes.length-8,true);d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,1,true);d.setUint32(24,16000,true);d.setUint32(28,32000,true);d.setUint16(32,2,true);d.setUint16(34,16,true);d.setUint32(40,3200,true);
          fetch('/api/transcriptions',{method:'POST',headers:{'content-type':'audio/wav'},body:bytes}).then(async response=>{if(!response.ok)throw Error('ASR '+response.status);const data=await response.json(),at=performance.now();
            const event={id,revision:1,status:'final',startMs:0,endMs:100,sourceText:data.text};attachCaptionTiming(event,{chunkSpeechAt:start,chunkDetectedAt:start,queuedAt:start,dequeuedAt:start,requestAt:start,responseAt:at});registerCaptionTiming(id,event);setEntries([event]);window.completed=id;
          }).catch(error=>window.testError=String(error));return id;
        }};
        return view==='live'?<div className="transcript">{entries.map(event=><CaptionPaintMetric key={event.id} members={[event]} text={event.sourceText}/>)}</div>:<div>settings</div>;
      }createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, format: 'iife', outfile: path.join(renderer, 'fixture.js') })
    await fs.writeFile(path.join(renderer, 'index.html'), '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
    // Reserve a free loopback port, then use the exact gateway server/static/API path.
    const probe = createServer(); await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve)})
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    child = spawn(process.execPath, [path.resolve('server/index.cjs')], { cwd: directory, env: { PATH: process.env.PATH, S2T_PROCESS_ROLE: 'api', S2T_WEB_PORT: String(port), S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'isolated-browser-test-secret', S2T_ASR_ENDPOINT: `http://127.0.0.1:${mock.address().port}/v1`, S2T_ASR_MODEL: 'mock', S2T_ASR_API_KEY: 'local-only', S2T_LOG_LEVEL: 'error' }, stdio: ['ignore','pipe','pipe'] })
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data)
    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let i=0;i<100;i++){try{if((await fetch(origin+'/readyz')).ok){ready=true;break}}catch{}await sleep(100)}assert.ok(ready,output)
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
    const context = await browser.newContext(), page = await context.newPage(), samples = [], errors = []
    const registered = await context.request.post(origin+'/api/auth/register',{data:{username:'browser-metrics',password:'local-test-password',NT:'browser-metrics',Department:'test'}})
    assert.equal(registered.status(),201)
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
    page.on('pageerror', error => errors.push(error.message))
    page.on('request',request=>{if(request.url().endsWith('/api/telemetry/captions')) samples.push(...request.postDataJSON().samples)})
    await page.goto(origin); await page.waitForFunction(()=>window.testHarness)
    const run = async () => {const id=await page.evaluate(()=>window.testHarness.begin());await page.waitForFunction(id=>window.completed===id,id);await sleep(800)}
    await run();assert.equal(samples.filter(sample=>sample.stage==='response_to_paint').length,1)
    const id=await page.evaluate(()=>window.testHarness.begin())
    await sleep(150);await page.evaluate(()=>window.testHarness.navigate('settings'));await sleep(150);await page.evaluate(()=>window.testHarness.navigate('live'))
    await page.waitForFunction(id=>window.completed===id,id);await sleep(800)
    assert.equal(samples.filter(sample=>sample.stage==='response_to_paint').length,1,'request spanning navigation must not paint as a latency sample')
    assert.equal(samples.filter(sample=>sample.stage==='asr_roundtrip_with_retries').length,1,'cross-boundary browser callbacks must not inflate roundtrip latency')
    await run();assert.equal(samples.filter(sample=>sample.stage==='response_to_paint').length,2,'fresh request after return remains measurable')
    assert.ok(samples.filter(sample=>sample.stage==='response_to_paint').every(sample=>sample.seconds>=0&&sample.seconds<.25))
    assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.testError),undefined)
    console.log('PASS real Chrome + isolated gateway: live RAF paints, in-flight navigation exclusion, fresh captions after return; all calls stay on loopback.')
  } finally {
    await browser?.close();if(child){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL')}
    await new Promise(resolve=>mock.close(resolve));await fs.rm(directory,{recursive:true,force:true})
  }
})().catch(error=>{console.error(error);process.exitCode=1})
