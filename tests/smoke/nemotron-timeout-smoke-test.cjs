const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const repo=require('node:path').resolve(__dirname,'../..');const source=fs.readFileSync(repo+'/server/nemotron-diarization.cjs','utf8');
for(const [seconds,env] of [[29.9706875,{}],[42.1013125,{}],[60,{}],[.0100625,{}],[42.1013125,{S2T_SHERPA_JOB_TIMEOUT_BASE_MS:'60000.3',S2T_SHERPA_JOB_TIMEOUT_PER_AUDIO_SEC:'400.1'}]]){
let timeout,cleaned=false;const samples=new Float32Array(Math.round(seconds*16000));const mockRequire=name=>{
if(name==='node:fs')return {mkdtempSync:()=>'/tmp/timeout-test',writeFileSync:()=>{},readFileSync:p=>p==='model'?Buffer.from('mock model'):'',rmSync:()=>{cleaned=true},accessSync:()=>{},constants:fs.constants};
if(name==='node:child_process')return {execFileSync:(_file,args,options)=>{if(args[0]==='diarize')timeout=options.timeout;return execFileSync(process.execPath,['-e',''],options)}};
if(name==='node:crypto')return {createHash:()=>({update(){return this},digest:()=> '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1'})};
if(name==='./local-diarization.cjs')return {nemotronPaths:()=>({model:'model',runtime:'runtime'})};
if(name==='./sherpa-diarization.cjs')return {readWavSamples:()=>({samples,sampleRate:16000}),resampleMono:s=>s};
if(name==='./logger.cjs')return {logger:{error:()=>{}}};return require(name)};
const m={exports:{}};new Function('require','module','exports','process',source)(mockRequire,m,m.exports,{platform:process.platform,arch:process.arch,env});assert.deepEqual(m.exports.diarizeWav(Buffer.alloc(0)),[]);assert.ok(Number.isInteger(timeout)&&timeout>=1);assert.equal(cleaned,true);console.log(JSON.stringify({seconds,timeout,valid:true}));}
