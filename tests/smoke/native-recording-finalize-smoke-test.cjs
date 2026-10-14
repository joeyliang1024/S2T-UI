const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const { createWriteStream, existsSync } = require('node:fs'), { mkdtemp, readFile, rm } = require('node:fs/promises'), { join } = require('node:path'), { tmpdir } = require('node:os')
const code = buildSync({ entryPoints:['src/main/recording/finalize-recording.ts'], bundle:true,format:'cjs',platform:'node',write:false }).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const { finalizeRecording, releaseRecordings }=m.exports
const header=(rate,bytes)=>{const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(36+bytes,4);b.write('WAVE',8);b.writeUInt32LE(rate,24);b.writeUInt32LE(bytes,40);return b}
;(async()=>{
 const dir=await mkdtemp(join(tmpdir(),'s2t-native-finalize-'))
 try{
  const recording=async name=>{const path=join(dir,name),stream=createWriteStream(path);await new Promise((resolve,reject)=>stream.write(Buffer.concat([header(16000,0),Buffer.from([1,2,3,4])]),error=>error?reject(error):resolve()));return{path,stream,sampleRate:16000,bytesWritten:4,writes:Promise.resolve()}}
  let commits=0
  const good=await recording('good.wav');assert.equal((await finalizeRecording(good,{header,committed:async()=>{commits++}})).audioPath,good.path)
  const bytes=await readFile(good.path);assert.equal(bytes.readUInt32LE(40),4);assert.deepEqual([...bytes.subarray(44)],[1,2,3,4]);assert.equal(good.stream.closed,true);assert.equal(commits,1)
  const failed=await recording('failed.wav');failed.writes=Promise.reject(Error('disk write failed'))
  await assert.rejects(finalizeRecording(failed,{header,committed:async()=>{commits++}}),/disk write failed/)
  assert.equal(failed.stream.closed,true);assert.equal(existsSync(failed.path),true);assert.equal(commits,1,'failed writes cannot mark metadata committed')
  const metadata=await recording('metadata.wav');await assert.rejects(finalizeRecording(metadata,{header,committed:async()=>{throw Error('manifest unavailable')}}),/manifest unavailable/)
  assert.equal(metadata.stream.closed,true);assert.equal((await readFile(metadata.path)).readUInt32LE(40),4)
  const records = new Map([['one',{...good,senderId:1}],['two',{...good,senderId:1}],['other',{...good,senderId:2}]])
  const seen=[]; const releasing=releaseRecordings(records,record=>record.senderId===1,id=>{seen.push(id);if(id==='one')throw Error('one release failed');return Promise.resolve()})
  assert.deepEqual([...records.keys()],['other'],'release stops admission for only its sender before awaiting I/O')
  await assert.rejects(releasing,AggregateError);assert.deepEqual(seen,['one','two'],'one failure cannot skip remaining releases')
  console.log('PASS native finalization: real WAV header/payload, descriptor closure, failed writes retain source and metadata failure retains recoverable completed audio')
 }finally{await rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1})
