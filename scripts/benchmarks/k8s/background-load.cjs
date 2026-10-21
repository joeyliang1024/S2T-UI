const {Pool}=require('pg'),jwt=require('jsonwebtoken'),{randomUUID}=require('node:crypto'),{createServer}=require('node:http')
const workers=Number(process.env.S2T_PERF_BACKGROUND_WORKERS||16),seconds=Number(process.env.S2T_PERF_SECONDS||120),run=randomUUID().slice(0,8)
const report={run,workers,seconds,finished:false,attempted:0,errors:0,completed:{asr:0,translation:0,summary:0},statuses:{},failures:{}}
createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(report))}).listen(9096,'0.0.0.0')
const audio=Buffer.alloc(64044);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(64000,40)
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
;(async()=>{
 const prefix=`perf-background-${run}-`,pool=new Pool({host:'postgres',database:'s2t',user:'s2t',password:process.env.PG_TEST_PASSWORD,max:1,connectionTimeoutMillis:3000,query_timeout:5000})
 await pool.query("INSERT INTO s2t_users(id,username,password_hash,nt,department,role) SELECT $1||n,$1||n,'benchmark-no-password-login',$1||n,'performance','user' FROM generate_series(0,$2) n",[prefix,workers-1]);await pool.end()
 const start=Number(process.env.S2T_PERF_START_AT);await pause(Math.max(0,start-Date.now()))
 report.startedAt=new Date().toISOString()
 await Promise.all(Array.from({length:workers},async(_,i)=>{
  const token=jwt.sign({sub:prefix+i,jti:`${run}-${i}`},process.env.PERF_AUTH_SECRET,{expiresIn:'2h'}),kind=['asr','translation','summary'][i%3]
  while(Date.now()<start+seconds*1000){
   report.attempted++
   try{
    const path=kind==='asr'?'transcriptions':kind==='translation'?'translations':'summaries'
    const body=kind==='asr'?audio:JSON.stringify(kind==='translation'?{text:'Background quality correction.',sourceLanguage:'en-US',targetLanguage:'zh-TW'}:{messages:[{role:'user',content:'Background summary.'}],singleAttempt:true})
    const response=await fetch(`http://gateway:8787/api/${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-s2t-workload':'background','content-type':kind==='asr'?'audio/wav':'application/json','x-s2t-idempotency-key':randomUUID()},body,signal:AbortSignal.timeout(90000)})
    report.statuses[response.status]=(report.statuses[response.status]||0)+1
    const payload=await response.json();if(!response.ok||!payload.text?.trim())throw Error(`HTTP ${response.status}: ${payload.error||'empty output'}`)
    report.completed[kind]++
   }catch(error){report.errors++;const text=error.message.slice(0,160);report.failures[text]=(report.failures[text]||0)+1;await pause(1000)}
   await pause(kind==='summary'?5100:350) // stay within each account's summary request-rate limit
  }
 }))
 report.finished=true;console.log(JSON.stringify(report))
})().catch(error=>{report.errors++;report.failures.startup=error.message;console.error(error);process.exitCode=1})
