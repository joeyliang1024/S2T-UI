const fs=require('node:fs'),crypto=require('node:crypto')
const users=JSON.parse(fs.readFileSync('/tmp/stress-users.json'))
const recordings=JSON.parse(fs.readFileSync('/tmp/storage-results.json'))
const seconds=Number(process.argv[2]||60),sleep=ms=>new Promise(r=>setTimeout(r,ms)),tasks=new Set()
const metrics={startedAt:new Date().toISOString(),seconds,requests:0,errors:[],latency:{},bytes:{},status:{},schedulerLagMaxMs:0}
async function call(kind,i,path){
 const start=Date.now()
 try{
  const r=await fetch('http://gateway:8787'+path,{headers:kind==='static'?{}:{authorization:'Bearer '+users[i].token},signal:AbortSignal.timeout(30000)})
  const raw=Buffer.from(await r.arrayBuffer())
  metrics.status[kind]??={};metrics.status[kind][r.status]=(metrics.status[kind][r.status]||0)+1
  if(r.status!==200)throw Error('HTTP '+r.status)
  if(kind==='audio' && crypto.createHash('sha256').update(raw).digest('hex')!==recordings[i].sha256)throw Error('audio checksum')
  ;(metrics.latency[kind]??=[]).push(Date.now()-start)
  metrics.bytes[kind]=(metrics.bytes[kind]||0)+raw.length
 }catch(e){if(metrics.errors.length<20)metrics.errors.push({kind,message:e.message});metrics.failed=(metrics.failed||0)+1}
}
function schedule(kind,i,path){metrics.requests++;const p=call(kind,i,path);tasks.add(p);p.finally(()=>tasks.delete(p))}
;(async()=>{
 const start=Date.now(),total=seconds*20
 for(let tick=0;tick<total;tick++){
  const due=start+tick*50;await sleep(Math.max(0,due-Date.now()));metrics.schedulerLagMaxMs=Math.max(metrics.schedulerLagMaxMs,Date.now()-due)
  const i=tick%100,cycle=Math.floor(tick/100)
  schedule('sessions',i,'/api/data/sessions')
  if(cycle%2===0){schedule('auth',i,'/api/auth/me');schedule('config',i,'/api/config')}
  if(cycle===0)schedule('audio',i,'/api/data/audio/audio-'+users[i].user.id)
  if(tick%20===0)schedule('static',i,'/')
 }
 await Promise.all(tasks)
 for(const[k,a]of Object.entries(metrics.latency)){a.sort((a,b)=>a-b);metrics.latency[k]={n:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)],max:a.at(-1)}}
 metrics.elapsedMs=Date.now()-start;metrics.failed??=0;console.log(JSON.stringify(metrics))
})().catch(e=>{console.error(e);process.exitCode=1})
