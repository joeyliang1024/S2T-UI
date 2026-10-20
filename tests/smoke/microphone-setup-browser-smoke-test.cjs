const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const { build } = require('esbuild')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {MicrophoneSetupDialog} from './src/renderer/src/features/capture/views/MicrophoneSetupDialog';
    import {interfaceTranslate} from './src/renderer/src/shared/i18n';
    window.testState={streams:[],contexts:[],applied:[],signal:0,denied:false,details:0,delays:[],systemStreams:[],audioApplied:[]};
    const state=window.testState;
    const devices=[{kind:'audioinput',deviceId:'usb',label:'USB Microphone'},{kind:'audioinput',deviceId:'headset',label:'Headset'}];
    Object.defineProperty(navigator,'mediaDevices',{value:{
      enumerateDevices:async()=>devices,addEventListener(){},removeEventListener(){},
      getDisplayMedia:async()=>{
        const tracks=[{kind:'audio',readyState:'live',stop(){this.stopped=true;this.readyState='ended'},addEventListener(){},removeEventListener(){}},{kind:'video',readyState:'live',stop(){this.stopped=true;this.readyState='ended'}}];
        tracks[0].addEventListener=(name,listener)=>{if(name==='ended')tracks[0].ended=listener};tracks[0].removeEventListener=()=>{};
        const stream={getTracks:()=>tracks,getAudioTracks:()=>state.noSystemAudio?[]:[tracks[0]]};state.systemStreams.push(stream);return stream;
      },
      getUserMedia:async constraints=>{
        if(state.denied)throw new Error('Permission denied');
        const track={stopped:false,stop(){this.stopped=true},addEventListener(){}};
        state.streams.push(track);
        if(state.delay) await new Promise(resolve=>state.delays.push(resolve));
        return {getTracks:()=>[track],getAudioTracks:()=>[track]};
      }
    }});
    window.AudioContext=class {
      state='running';constructor(){state.contexts.push(this)}
      createAnalyser(){return{fftSize:2048,getFloatTimeDomainData(samples){samples.fill(state.signal)}}}
      createMediaStreamSource(){return{connect(){}}}async resume(){}async close(){this.state='closed'}
    };
    const ui=key=>interfaceTranslate('en',key);
    function App(){const[open,setOpen]=useState(false),[device,setDevice]=useState('default'),[audioMode,setAudioMode]=useState(false),[system,setSystem]=useState(false),[shared,setShared]=useState(null);return <>
      <button onClick={()=>{setAudioMode(false);setOpen(true)}}>Configure microphone</button><button onClick={()=>{setAudioMode(true);setOpen(true)}}>Configure audio</button><output>{device}</output>
      {open&&<MicrophoneSetupDialog selectedDeviceId={device} devices={devices} denoiseEnabled={true} disabled={false} ui={ui} includeSystemAudio={system} existingSystemStream={shared} confirmLabel={audioMode?ui('confirmStartRecording'):undefined} applyAudio={audioMode?async (device,enabled,stream)=>{state.applyAttempts=(state.applyAttempts||0)+1;if(state.failApply)throw new Error('Apply failed');if(state.blockApply)await new Promise(resolve=>state.finishApply=resolve);state.audioApplied.push({device,enabled});setDevice(device);setSystem(enabled);setShared(stream||null)}:undefined}
        close={()=>setOpen(false)} details={()=>state.details++} apply={async value=>{state.applied.push(value);setDevice(value)}}/>}
    </>}createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, format: 'iife', write: false })
  const script = bundle.outputFiles[0].text
  const server = http.createServer((req, res) => { if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end(fs.readFileSync('src/renderer/src/styles.css')) } res.setHeader('content-type', req.url === '/app.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/app.js' ? script : '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>') })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  let browser
  try {
    browser = await chromium.launch(browserOptions())
    const page = await browser.newPage(); page.setDefaultTimeout(10000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const open = () => page.getByRole('button', { name: 'Configure microphone', exact: true }).click()
    const select = () => page.getByRole('combobox')
    const dialog = () => page.getByRole('dialog')
    const checkReleased = async () => assert.ok(await page.evaluate(() => window.testState.streams.every(track => track.stopped) && window.testState.contexts.every(context => context.state === 'closed')), 'every preview stream and context is released')
    await open()
    await page.getByText('No sound yet. Speak into your microphone.', { exact: true }).waitFor()
    await select().selectOption('usb')
    await page.waitForFunction(() => window.testState.streams.length === 2 && window.testState.streams[0].stopped)
    assert.equal(await page.locator('output').innerText(), 'default', 'preview does not change the selected input')
    await page.evaluate(() => window.testState.signal = .1)
    await page.getByText('Sound detected', { exact: true }).waitFor()
    assert.ok(Number(await page.getByRole('meter').getAttribute('aria-valuenow')) > -30)
    const bounds = await dialog().boundingBox()
    const applyBounds = await page.getByRole('button', { name: 'Confirm and apply' }).boundingBox()
    assert.ok(bounds && applyBounds && applyBounds.y + applyBounds.height <= bounds.y + bounds.height && applyBounds.x >= bounds.x && applyBounds.x + applyBounds.width <= bounds.x + bounds.width, 'dialog actions stay inside the small window')
    await page.screenshot({ path: '/tmp/s2t-microphone-setup.png', fullPage: true })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await dialog().count(), 0); await checkReleased()
    assert.deepEqual(await page.evaluate(() => window.testState.applied), [])
    await open(); assert.equal(await select().inputValue(), 'default')
    await select().selectOption('headset')
    await page.getByRole('button', { name: 'Confirm and apply' }).click()
    assert.equal(await dialog().count(), 0); assert.equal(await page.locator('output').innerText(), 'headset'); await checkReleased()
    await page.evaluate(() => window.testState.denied = true)
    await open(); await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Confirm and apply' }).isDisabled(), true)
    await page.evaluate(() => window.testState.denied = false)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByText('Sound detected', { exact: true }).waitFor()
    await page.keyboard.press('Escape'); assert.equal(await dialog().count(), 0); await checkReleased()
    await page.evaluate(() => window.testState.delay = true)
    await open(); await page.waitForFunction(() => window.testState.delays.length === 1)
    await select().selectOption('usb'); await page.waitForFunction(() => window.testState.delays.length === 2)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => { window.testState.delay = false; window.testState.delays.splice(0).forEach(resolve => resolve()) })
    await page.waitForFunction(() => window.testState.streams.every(track => track.stopped)); await checkReleased()
    await open(); await select().selectOption('none')
    await page.getByRole('button', { name: 'Confirm and apply' }).click()
    assert.equal(await page.locator('output').innerText(), 'none'); await checkReleased()
    await open(); await page.getByRole('button', { name: 'Detailed capture settings' }).click()
    assert.equal(await dialog().count(), 0); assert.equal(await page.evaluate(() => window.testState.details), 1)
    // The extra chooser includes computer audio and transfers only confirmed streams.
    const openAudio = () => page.getByRole('button', { name: 'Configure audio', exact: true }).click()
    await openAudio()
    await page.locator('#microphone-setup form').evaluate(form => form.requestSubmit())
    assert.deepEqual(await page.evaluate(() => window.testState.audioApplied), [], 'Enter/form submit cannot confirm without an input')
    await page.getByRole('combobox', { name: 'System audio', exact: true }).selectOption('system')
    await page.getByRole('button', { name: 'Confirm and start recording' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Confirm and start recording' }).isDisabled(), true)
    await page.getByRole('button', { name: 'Choose system audio', exact: true }).click()
    await page.waitForFunction(() => window.testState.systemStreams.length === 1)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.ok(await page.evaluate(() => window.testState.systemStreams[0].getTracks().every(track => track.stopped)))
    assert.deepEqual(await page.evaluate(() => window.testState.audioApplied), [])
    await openAudio()
    await page.getByRole('combobox', { name: 'System audio', exact: true }).selectOption('system')
    await page.getByRole('button', { name: 'Choose system audio', exact: true }).click()
    await page.waitForFunction(() => window.testState.systemStreams.length === 2)
    await page.getByRole('button', { name: 'Confirm and start recording' }).click()
    assert.deepEqual(await page.evaluate(() => window.testState.audioApplied), [{device:'none',enabled:true}])
    assert.ok(await page.evaluate(() => window.testState.systemStreams[1].getTracks().every(track => !track.stopped)), 'confirmed computer stream is retained for recording')
    await openAudio(); await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.ok(await page.evaluate(() => window.testState.systemStreams[1].getTracks().every(track => !track.stopped)), 'cancel preserves an existing computer source')
    await page.evaluate(() => window.testState.noSystemAudio = true)
    await openAudio()
    await page.getByRole('button', { name: 'Choose system audio', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.ok(await page.evaluate(() => window.testState.systemStreams.at(-1).getTracks().every(track => track.stopped)), 'a share without audio is released')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => window.testState.systemStreams.forEach(stream => stream.getTracks().forEach(track => track.stop())))
    await page.evaluate(() => { window.testState.noSystemAudio = false; window.testState.failApply = true })
    await openAudio()
    await page.getByRole('button', { name: 'Choose system audio', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and start recording' }).click()
    await page.getByRole('alert').waitFor()
    assert.ok(await page.evaluate(() => window.testState.systemStreams.at(-1).getAudioTracks()[0].readyState === 'live'), 'failed apply retains the preview for retry')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.ok(await page.evaluate(() => window.testState.systemStreams.at(-1).getTracks().every(track => track.stopped)), 'cancel after failed apply releases the pending share')
    await page.evaluate(() => { window.testState.failApply = false; window.testState.blockApply = true })
    await openAudio()
    await page.getByRole('button', { name: 'Choose system audio', exact: true }).click()
    await page.evaluate(() => {
      const form=document.querySelector('#microphone-setup form'); form.requestSubmit(); form.requestSubmit()
    })
    await page.waitForFunction(() => Boolean(window.testState.finishApply))
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => window.testState.applyAttempts), 3, 'duplicate form events invoke apply only once')
    await page.evaluate(() => { window.testState.finishApply(); window.testState.blockApply = false })
    await dialog().waitFor({state:'detached'})
    await openAudio()
    await page.evaluate(() => { const track=window.testState.systemStreams.at(-1).getAudioTracks()[0]; track.readyState='ended'; track.ended() })
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Confirm and start recording' }).isDisabled(), true, 'ended share cannot start recording')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => window.testState.systemStreams.forEach(stream => stream.getTracks().forEach(track => track.stop())))
    assert.deepEqual(errors, [])
    console.log('PASS microphone preview, live sound meter, deferred apply/cancel, permission retry, Escape, none input, detailed settings and stale-stream cleanup; no physical microphone used')
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
