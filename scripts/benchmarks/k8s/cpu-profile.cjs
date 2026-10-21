const fs=require('node:fs/promises')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
;(async()=>{
 const targets=await fetch('http://127.0.0.1:9229/json/list').then(r=>r.json())
 const ws=new WebSocket(targets[0].webSocketDebuggerUrl),pending=new Map();let sequence=0
 ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const p=pending.get(data.id);pending.delete(data.id);if(data.error)p.reject(Error(data.error.message));else p.resolve(data.result)}})
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})
 await call('Profiler.enable');await call('Profiler.start');console.log('CPU profiling started')
 await delay(45000)
 const {profile}=await call('Profiler.stop');await fs.writeFile('/tmp/s2t-gateway.cpuprofile',JSON.stringify(profile));await call('Profiler.disable');ws.close();console.log('CPU profile saved')
})().catch(error=>{console.error(error);process.exitCode=1})
