const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: "export * from './src/renderer/src/features/capture/recording/sink-lifecycle'; export * from './src/renderer/src/features/capture/recording/adapters/pcm-sinks'; export * from './src/renderer/src/features/capture/recording/adapters/remote-pcm-recording'; export * from './src/renderer/src/shared/http/authenticated-client';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { createPcmSink, createBrowserPcmSink, createDesktopPcmSink, RemotePcmRecording, setAuthenticatedUser } = m.exports
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
;(async () => {
  const gate = deferred(), order = []; let released = 0
  const sink = createPcmSink({ append: async audio => { order.push(new Uint8Array(audio)[0]); await gate.promise }, finish: async () => { order.push('finish'); return { kind:'remote',recordingId:'a',persistedSamples:2 } }, release: async () => { released++ } })
  const bytes = new Uint8Array([1,2]), first = sink.append(bytes.buffer); bytes.fill(9)
  const second = sink.append(new Uint8Array([3,4]).buffer), finishing = sink.finish()
  assert.equal(sink.finish(), finishing); await assert.rejects(sink.append(new ArrayBuffer(2)), /closed/)
  await Promise.resolve(); assert.deepEqual(order,[1]); gate.resolve(); await Promise.all([first,second,finishing]); assert.deepEqual(order,[1,3,'finish'])
  const abort = sink.abort(); assert.equal(sink.abort(),abort); await abort; assert.equal(released,1)
  let localFinished = 0, localWrites = 0
  const stages = [], local = { sealForRecovery: async () => {}, append: async () => { localWrites++ }, finish: async () => { localFinished++; return new Blob(['durable prefix']) } }
  const browser = createBrowserPcmSink({ recordingId:'browser',recording:local,remoteRecording:{ append:async()=>{}, finish:async()=>{ throw Error('remote finish outage') },get persistedSamples(){return 1} },onWriteStage:stage=>stages.push(stage) })
  await browser.append(new ArrayBuffer(2)); await assert.rejects(browser.finish(), /remote finish outage/); await browser.abort()
  assert.equal(localWrites,1); assert.equal(localFinished,1); assert.deepEqual(stages,['browser','remote','idle'])
  let finalizations = 0, appends = 0
  const desktop = createDesktopPcmSink('native', { appendPcm: async () => { appends++; return {bytesWritten:2} }, finishPcmRecording: async () => { finalizations++; return {audioPath:'/fixture.wav'} } })
  await desktop.append(new ArrayBuffer(2)); await desktop.abort(); await desktop.abort(); assert.equal(appends,1); assert.equal(finalizations,1)
  await assert.rejects(desktop.finish(), /closed/)
  const failure = createPcmSink({ append:async()=>{throw Error('disk failure')},finish:async()=>{throw Error('must not finish failed writes')},release:async()=>{released++} })
  await assert.rejects(failure.append(new ArrayBuffer(2)), /disk failure/); await assert.rejects(failure.finish(), /disk failure/); await failure.abort(); assert.equal(released,2)
  setAuthenticatedUser('pcm-user-a'); let network = 0
  const remote = new RemotePcmRecording('recording',16000,async (_path,init) => { network++; return {ok:true,json:async()=>{setAuthenticatedUser('pcm-user-b');return{durable:true,contiguousChunks:1,persistedSamples:init.body.byteLength/2}}} })
  await assert.rejects(remote.append(new ArrayBuffer(1024*1024+2)), {name:'AbortError'}); assert.equal(network,1,'second chunk cannot use a different account')
  await assert.rejects(remote.promote('history'), {name:'AbortError'}); assert.equal(network,1)
  console.log('PASS PCM sinks: immutable serial writes, drain before finish, idempotent finish/abort, local-before-remote commit, failure evidence retention and multi-request account fencing')
})().catch(error=>{console.error(error);process.exitCode=1})
