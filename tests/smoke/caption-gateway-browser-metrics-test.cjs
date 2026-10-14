const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { build } = require('esbuild')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
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
      import {attachCaptionTiming, parseServerTiming, registerCaptionTiming, setCaptionMeasurementActive} from './src/renderer/src/shared/services/caption-metrics';
      import {CaptionPaintMetric} from './src/renderer/src/features/captions/views/CaptionPaintMetric';
      let sequence=0;
      function App(){const [view,setView]=useState('live'),[entries,setEntries]=useState([]);
        useLayoutEffect(()=>{setCaptionMeasurementActive(view==='live');return ()=>setCaptionMeasurementActive(false)},[view]);
        window.testHarness={navigate:setView,begin:()=>{const id='test-'+(++sequence),start=performance.now();
          const bytes=new Uint8Array(44+3200);const d=new DataView(bytes.buffer);for(const [offset,text] of [[0,'RIFF'],[8,'WAVEfmt '],[36,'data']])for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);
          d.setUint32(4,bytes.length-8,true);d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,1,true);d.setUint32(24,16000,true);d.setUint32(28,32000,true);d.setUint16(32,2,true);d.setUint16(34,16,true);d.setUint32(40,3200,true);
          fetch('/api/transcriptions',{method:'POST',headers:{'content-type':'audio/wav'},body:bytes}).then(async response=>{if(!response.ok)throw Error('ASR '+response.status);const server=parseServerTiming(response.headers.get('server-timing')),data=await response.json(),at=performance.now();
            const event={id,revision:1,status:'final',startMs:0,endMs:100,sourceText:data.text};attachCaptionTiming(event,{chunkSpeechAt:start,chunkDetectedAt:start,queuedAt:start,dequeuedAt:start,requestAt:start,responseAt:at,postEndAt:at,server});registerCaptionTiming(id,event);setEntries([event]);window.completed=id;
          }).catch(error=>window.testError=String(error));return id;
        }};
        return view==='live'?<div className="transcript">{entries.map(event=><CaptionPaintMetric key={event.id} members={[event]} text={event.sourceText}/>)}</div>:<div>settings</div>;
      }createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, format: 'iife', outfile: path.join(renderer, 'fixture.js') })
    await fs.writeFile(path.join(renderer, 'index.html'), '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
    // Reserve a free loopback port, then use the exact gateway server/static/API path.
    const probe = createServer(); await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve)})
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    child = spawn(process.execPath, [path.resolve('server/index.cjs')], { cwd: directory, env: { PATH: process.env.PATH, S2T_PROCESS_ROLE: 'api', S2T_WEB_PORT: String(port), S2T_ALLOW_DEFAULT_ADMIN: 'true', S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'isolated-browser-test-secret', S2T_ASR_ENDPOINT: `http://127.0.0.1:${mock.address().port}/v1`, S2T_ASR_MODEL: 'mock', S2T_ASR_API_KEY: 'local-only', S2T_LOG_LEVEL: 'error' }, stdio: ['ignore','pipe','pipe'] })
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data)
    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let i=0;i<100;i++){try{if((await fetch(origin+'/readyz')).ok){ready=true;break}}catch{}await sleep(100)}assert.ok(ready,output)
    browser = await chromium.launch(browserOptions())
    const context = await browser.newContext(), page = await context.newPage(), samples = [], errors = []
    const registered = await context.request.post(origin+'/api/auth/register',{data:{username:'browser-metrics',password:'local-test-password',NT:'browser-metrics',Department:'test'}})
    assert.equal(registered.status(),201)
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
    page.on('pageerror', error => errors.push(error.message))
    page.on('request',request=>{if(request.url().endsWith('/api/telemetry/captions')) samples.push(...request.postDataJSON().samples)})
    await page.goto(origin); await page.waitForFunction(()=>window.testHarness)
    const run = async () => {const id=await page.evaluate(()=>window.testHarness.begin());await page.waitForFunction(id=>window.completed===id,id);await sleep(800)}
    const count = stage => samples.filter(sample=>sample.stage===stage).length
    await run();assert.equal(count('t5_paint'),1)
    const id=await page.evaluate(()=>window.testHarness.begin())
    await sleep(150);await page.evaluate(()=>window.testHarness.navigate('settings'));await sleep(150);await page.evaluate(()=>window.testHarness.navigate('live'))
    await page.waitForFunction(id=>window.completed===id,id);await sleep(800)
    assert.equal(count('t5_paint'),1,'request spanning navigation must not paint as a latency sample')
    assert.equal(count('t5_network'),1,'cross-boundary browser callbacks must not inflate roundtrip latency')
    await run();assert.equal(count('t5_paint'),2,'fresh request after return remains measurable')
    assert.equal(count('e2e_asr'),2,'each live caption contributes one end-to-end sample')
    assert.ok(samples.filter(sample=>sample.stage==='t5_paint').every(sample=>sample.seconds>=0&&sample.seconds<.25))
    // Real gateway Server-Timing split: the mock upstream sleeps 1.2s inside
    // asr_model, so t3_model must carry it while t5_network shrinks to the network.
    assert.equal(count('t3_model'),2,'Server-Timing model slice arrives through telemetry')
    assert.ok(samples.filter(sample=>sample.stage==='t3_model').every(sample=>sample.seconds>=1&&sample.seconds<3),'t3_model mirrors the upstream latency')
    assert.ok(samples.filter(sample=>sample.stage==='t5_network').every(sample=>sample.seconds>=0&&sample.seconds<1),'t5_network = roundtrip − server total, not the whole request')
    assert.ok(samples.filter(sample=>sample.stage==='t1_upload').every(sample=>sample.seconds>=0),'t1_upload is the server-side body read')
    assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.testError),undefined)
    console.log('PASS real Chrome + isolated gateway: live RAF paints, in-flight navigation exclusion, fresh captions after return; all calls stay on loopback.')
  } finally {
    await browser?.close();if(child){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL')}
    await new Promise(resolve=>mock.close(resolve));await fs.rm(directory,{recursive:true,force:true})
  }
})().catch(error=>{console.error(error);process.exitCode=1})
