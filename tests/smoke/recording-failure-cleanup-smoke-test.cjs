const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: "export * from './frontend/src/features/capture/recording/buffered-writer';export * from './frontend/src/features/capture/recording/adapters/opfs-write-client';export * from './frontend/src/features/sessions/services/recording-cleanup';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {BufferedPcmWriter,OpfsWriteClient,cleanupRecordingBackup}=m.exports
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
global.window={setTimeout,clearTimeout}
;(async()=>{
 let reject,paused=false,writes=0
 const events=[]
 const writer=new BufferedPcmWriter(async()=>{writes++;await new Promise((_r,j)=>{reject=j})},active=>{paused=active;events.push(active)},()=>{paused=true},2,4)
 writer.push(new ArrayBuffer(2));writer.push(new ArrayBuffer(4));reject(Error('disk full'));await flush()
 assert.equal(paused,true);assert.deepEqual(events,[true]);writer.push(new ArrayBuffer(2));assert.equal(writes,1)
 await assert.rejects(writer.closeAndDrain(),/disk full/)
 let terminated=0
 const worker={postMessage(){},terminate(){terminated++}}
 const client=new OpfsWriteClient(worker,15)
 await assert.rejects(client.write({},new ArrayBuffer(2),{}),e=>e.name==='TimeoutError')
 assert.equal(terminated,1);await assert.rejects(client.write({},new ArrayBuffer(2),{}),/closed/)
 // Late replies cannot turn a timed-out write into a commit or resume capture.
 worker.onmessage({data:{id:1,committed:true}})
 const order=[];let failRemote=true,epoch=0
 const input={recordingId:'capture-fixture',target:{sessionId:'saved',audioKey:'saved',processingToken:'token'},draftId:'draft',removeLocal:async()=>order.push('local')}
 const deps={removeRemote:async(_id,target)=>{assert.equal(target.processingToken,'token');order.push('remote');if(failRemote)throw Error('offline')},removeDraft:async()=>order.push('draft'),epoch:()=>epoch}
 await assert.rejects(cleanupRecordingBackup(input,deps),/offline/);assert.deepEqual(order,['remote'])
 failRemote=false;await cleanupRecordingBackup(input,deps);assert.deepEqual(order,['remote','remote','draft','local'])
 order.length=0;deps.removeRemote=async()=>{order.push('remote');epoch++}
 await assert.rejects(cleanupRecordingBackup(input,deps),/Account changed/);assert.deepEqual(order,['remote'])
 console.log('PASS permanent disk failure never resumes; silent worker deadline terminates; cleanup retains local intent until remote ACK; retries and account fencing')
})().catch(e=>{console.error(e);process.exitCode=1})
