// Open-arrival model requests with an independent durable PCM upload spool.
const fs = require('node:fs/promises'), crypto = require('node:crypto'), path = require('node:path')
const base = (process.env.S2T_LOAD_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
const users = Number(process.env.S2T_LOAD_CONCURRENCY || 500), seconds = Number(process.env.S2T_LOAD_DURATION_SECONDS || 600)
const cadence = Number(process.env.S2T_LOAD_CADENCE_MS || 2000)
const reportFile = process.env.S2T_LOAD_REPORT || '/tmp/s2t-recording-load.json'
let progress, archiveTimer
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)] : null
;(async () => {
  if (!Number.isInteger(users) || users<1 || users>500 || !Number.isInteger(seconds) || seconds<2 || seconds%2 || !Number.isInteger(cadence) || cadence<1000 || cadence>10000 || seconds*1000%cadence) throw Error('Invalid users, duration or cadence')
  const tokens = JSON.parse(await fs.readFile(process.env.S2T_LOAD_TOKENS_FILE || '/tmp/s2t-load-tokens.json', 'utf8')).slice(0,users)
  if(tokens.length!==users || new Set(tokens).size!==users) throw Error('Distinct credentials required')
  // Validate every identity before starting the measured arrival schedule.
  // A stale credential set must never be interpreted as server capacity data.
  let identityNext=0
  const identities=new Set()
  await Promise.all(Array.from({length:8},async()=>{for(;;){
    const index=identityNext++; if(index>=users)return
    const response=await fetch(base+'/api/auth/session',{headers:{authorization:'Bearer '+tokens[index]},signal:AbortSignal.timeout(15000)})
    if(!response.ok)throw Error('Credential preflight HTTP '+response.status)
    const value=await response.json()
    if(!value.user?.id || identities.has(value.user.id))throw Error('Distinct authenticated users required')
    identities.add(value.user.id)
  }}))
  console.log(JSON.stringify({credentialsVerified:identities.size}))
  const run='rec-'+Date.now().toString(36), ticks=seconds*1000/cadence, captureTicks=seconds/2, archivePcm=Buffer.alloc(64000), pcm=Buffer.alloc(32000*cadence/1000)
  for(let i=0;i<archivePcm.length;i++) archivePcm[i]=(i*17)%251
  for(let i=0;i<pcm.length;i++) pcm[i]=archivePcm[i%archivePcm.length]
  const frame=(user,tick)=>{
    const data=Buffer.from(archivePcm)
    data.writeUInt32LE(user,0);data.writeUInt32LE(tick,4)
    data.writeUInt32LE((~(user^tick))>>>0,8)
    data.writeUInt32LE((0xa5a50000^(user<<8)^tick)>>>0,12)
    return data
  }
  const modelPcm=(user,tick)=>{
    const output=Buffer.alloc(pcm.length),start=tick*pcm.length
    for(let copied=0;copied<output.length;){
      const position=start+copied,index=Math.floor(position/archivePcm.length),offset=position%archivePcm.length
      const source=frame(user,index),amount=Math.min(source.length-offset,output.length-copied)
      source.copy(output,copied,offset,offset+amount);copied+=amount
    }
    return output
  }
  const wav=Buffer.alloc(44+pcm.length); wav.write('RIFF');wav.writeUInt32LE(36+pcm.length,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44)
  const serverTimings={}, stages={}, failures={}, failedUsers=new Set(), modelPending=new Set()
  const states=Array.from({length:users},(_,i)=>({available:0,uploaded:0,chunks:0,next:0,running:null,range:null,seed:crypto.createHash('sha256').update(run+':'+i).digest().readUInt32LE(0)}))
  const nextInterval = state => { state.seed=(Math.imul(state.seed,1664525)+1013904223)>>>0; return Math.max(1,Math.ceil((15000+(state.seed/4294967296)*15000)/2000)) }
  for(const state of states) state.next=nextInterval(state)
  let offered=0,dropped=0,maxPending=0,schedulerLagMs=0,maxBacklogSeconds=0,finished=0,verified=0,cleaned=0
  const recordFailure = error => { const message=String(error.message)+(error.cause?.code?' ['+error.cause.code+']':''); failures[message]=(failures[message]||0)+1 }
  const request = async(user,stage,route,method,body,headers={},attempts=3) => {
    const metric=stages[stage]??={times:[],errors:0,statuses:{},retries:0}
    for(let attempt=0;attempt<attempts;attempt++) {
      const start=performance.now()
      try {
        const response=await fetch(base+route,{method,headers:{authorization:'Bearer '+tokens[user],...headers},body,signal:AbortSignal.timeout(30000)})
        metric.statuses[response.status]=(metric.statuses[response.status]||0)+1
        for(const part of (response.headers.get('server-timing')||'').split(',')) {
          const match=part.trim().match(/^([a-z_]+);dur=([0-9.]+)/)
          if(match)(serverTimings[stage+'.'+match[1]]??=[]).push(Number(match[2]))
        }
        if(!response.ok) throw Object.assign(Error(stage+' HTTP '+response.status+' '+(await response.text()).slice(0,150)),{status:response.status})
        return response.status===204?{}:await response.json()
      } catch(error) {
        metric.errors++; recordFailure(error)
        if(attempt+1===attempts || (error.status && error.status<500 && ![408,425,429].includes(error.status))) throw error
        metric.retries++; await sleep(Math.min(2000,250*2**attempt)*(0.75+Math.random()/2))
      } finally { metric.times.push(performance.now()-start) }
    }
  }
  const upload = (user,force=false) => {
    const state=states[user]
    if(state.running) return state.running
    if(state.uploaded===state.available || (!force && !state.range && state.available<state.next)) return Promise.resolve()
    const operation=(async()=>{
      do {
        if(!state.range) {
          const end=Math.min(state.available,state.uploaded+Math.floor(1024*1024/archivePcm.length))
          state.range={start:state.uploaded,end,bytes:Buffer.concat(Array.from({length:end-state.uploaded},(_,offset)=>frame(user,state.uploaded+offset)))}
        }
        const range=state.range
        const ack=await request(user,'recording',`/api/data/recordings/${run}-${user}/chunks/${state.chunks}`,'PUT',range.bytes,{'content-type':'application/octet-stream','x-s2t-start-sample':String(range.start*archivePcm.length/2),'x-s2t-sample-rate':'16000'},5)
        if(!ack.durable || ack.contiguousChunks!==state.chunks+1 || ack.persistedSamples!==range.end*archivePcm.length/2) throw Error('Invalid durable recording acknowledgement')
        state.uploaded=range.end; state.chunks++;state.range=null;state.next=state.uploaded+nextInterval(state)
      } while(force && state.uploaded<state.available)
    })().finally(()=>{if(state.running===operation)state.running=null})
    state.running=operation
    return operation
  }
  const speech = async(user,tick,scheduled) => {
    const chain=stages.chain??={times:[],errors:0,statuses:{},retries:0}
    try {
      const audio=Buffer.concat([wav.subarray(0,44),modelPcm(user,tick)])
      const result=await request(user,'asr','/api/transcriptions','POST',audio,{'content-type':'audio/wav','x-s2t-idempotency-key':`${run}-${user}-${tick}-asr`})
      await request(user,'translation','/api/translations','POST',JSON.stringify({text:result.text,sourceLanguage:'en-US',targetLanguage:'zh-TW'}),{'content-type':'application/json','x-s2t-idempotency-key':`${run}-${user}-${tick}-translation`})
    } catch(error) { failedUsers.add(user);chain.errors++ }
    finally { chain.times.push(performance.now()-scheduled) }
  }
  const requestedStart=Number(process.env.S2T_LOAD_START_AT||0)
  if(!Number.isSafeInteger(requestedStart)||requestedStart<0)throw Error('Invalid requested start time')
  if(requestedStart){await sleep(Math.max(0,requestedStart-Date.now()));if(Date.now()-requestedStart>1000)throw Error('Missed requested start time')}
  const startSkewMs=requestedStart?Date.now()-requestedStart:0
  const began=performance.now(),startedAt=new Date().toISOString()
  archiveTimer=setInterval(()=>{
    const available=Math.min(captureTicks,Math.floor((performance.now()-began)/2000))
    for(let user=0;user<users;user++){
      const state=states[user];state.available=available
      maxBacklogSeconds=Math.max(maxBacklogSeconds,(available-state.uploaded)*2)
      if(!state.running && state.available>state.uploaded && (state.range || state.available>=state.next))void upload(user).catch(()=>{})
    }
  },100)
  progress=setInterval(()=>console.log(JSON.stringify({elapsedSeconds:Math.round((performance.now()-began)/1000),offered,pending:modelPending.size,dropped,failedUsers:failedUsers.size,uploadedChunks:states.reduce((n,s)=>n+s.chunks,0),maxBacklogSeconds,finished,verified,cleaned,failures:Object.fromEntries(Object.entries(failures).slice(0,8))})),30000)
  for(let sequence=0;sequence<users*ticks;sequence++) {
    const scheduled=began+sequence*cadence/users
    const delay=scheduled-performance.now()
    if(delay>0) await sleep(delay)
    else if(sequence%32===0) await new Promise(resolve=>setImmediate(resolve))
    if(performance.now()-began>=seconds*1000){dropped+=users*ticks-sequence;break}
    const user=sequence%users,tick=Math.floor(sequence/users)
    // Recording production has its own clock and never waits for model work.
    offered++;schedulerLagMs=Math.max(schedulerLagMs,performance.now()-scheduled)
    if(modelPending.size>=users*4) dropped++
    else { const task=speech(user,tick,scheduled);modelPending.add(task);maxPending=Math.max(maxPending,modelPending.size);task.finally(()=>modelPending.delete(task)) }
  }
  await sleep(Math.max(0,began+seconds*1000-performance.now()))
  for(const state of states)state.available=captureTicks
  const captureEndedAt=new Date().toISOString(),captureWallSeconds=(performance.now()-began)/1000
  await Promise.all(modelPending)
  clearInterval(archiveTimer)
  await Promise.all(states.map(state=>state.running?.catch(()=>{})))
  let next=0
  // Capture concurrency has ended. Bound archive assembly/readback/cleanup to
  // eight users so verification copies do not require a second dataset on disk.
  await Promise.all(Array.from({length:8},async()=>{for(;;){const user=next++;if(user>=users)return;const state=states[user],id=run+'-'+user
    try {
      await upload(user,true)
      if(state.uploaded!==captureTicks)throw Error('Incomplete recording')
      await request(user,'finish',`/api/data/recordings/${id}/finish`,'POST',JSON.stringify({totalChunks:state.chunks,totalSamples:captureTicks*archivePcm.length/2}),{'content-type':'application/json'});finished++
      const response=await fetch(base+'/api/data/audio/'+id,{headers:{authorization:'Bearer '+tokens[user]},signal:AbortSignal.timeout(120000)})
      if(!response.ok)throw Error('Readback HTTP '+response.status)
      const expected=crypto.createHash('sha256');for(let tick=0;tick<captureTicks;tick++)expected.update(frame(user,tick));const expectedHash=expected.digest('hex')
      const hash=crypto.createHash('sha256');let offset=0
      for await(const block of response.body){const skip=Math.max(0,44-offset);if(block.length>skip)hash.update(block.subarray(skip));offset+=block.length}
      if(offset!==44+captureTicks*archivePcm.length || hash.digest('hex')!==expectedHash)throw Error('Recording byte mismatch')
      verified++
      await request(user,'cleanup',`/api/data/recordings/${id}`,'DELETE');cleaned++
    } catch(error) { failedUsers.add(user);recordFailure(error) }
  }}))
  clearInterval(progress)
  const report={serverTimings:Object.fromEntries(Object.entries(serverTimings).map(([name,values])=>[name,{count:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95)}])),run,startedAt,captureEndedAt,captureWallSeconds,startSkewMs,requestedStartAt:requestedStart?new Date(requestedStart).toISOString():null,finishedAt:new Date().toISOString(),users,seconds,cadenceMs:cadence,recordingCommitCadenceMs:2000,uniqueUserAndFrameMarkers:true,mockMs:500,offered,expected:users*ticks,dropped,maxPending,schedulerMaxLagMs:schedulerLagMs,maxRemoteBacklogSeconds:maxBacklogSeconds,capturePcmBytes:users*captureTicks*archivePcm.length,recordedPcmBytes:states.reduce((n,s)=>n+s.uploaded*archivePcm.length,0),recordingChunks:states.reduce((n,s)=>n+s.chunks,0),finished,verified,cleaned,failedUsers:failedUsers.size,failures,stages:Object.fromEntries(Object.entries(stages).map(([name,value])=>[name,{attempted:value.times.length,errors:value.errors,retries:value.retries,statuses:value.statuses,p50Ms:percentile(value.times,.5),p95Ms:percentile(value.times,.95),p99Ms:percentile(value.times,.99),maxMs:value.times.reduce((a,b)=>Math.max(a,b),0)}])),scope:'Distinct NT users, open-arrival ASR/translation every 2s by default; independent archive batches <=1 MiB with 15–30s jitter, bounded retries and durable-ACK progress. Independent 2-second virtual PCM producer; browser OPFS measured separately. Final assembly/readback/cleanup concurrency 8; session editing excluded.'}
  report.timingValid=captureWallSeconds<=seconds+1&&startSkewMs<=1000
  report.passed=report.timingValid&&offered===users*ticks&&!dropped&&!failedUsers.size&&verified===users&&cleaned===users
  report.zeroHttpErrors=Object.values(stages).every(stage=>!stage.errors)
  await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
})().catch(async error=>{console.error(error.message);await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify({passed:false,complete:false,reason:error.message})+'\n');process.exitCode=1}).finally(()=>{clearInterval(progress);clearInterval(archiveTimer)})
