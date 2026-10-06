const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{buildSync}=require('esbuild')
const mode=process.argv[2]||'baseline', source=mode==='baseline'?execFileSync('git',['show','4173eab:src/renderer/src/shared/services/caption-metrics.ts'],{encoding:'utf8'}):fs.readFileSync('src/renderer/src/shared/services/caption-metrics.ts','utf8')
const code=buildSync({stdin:{contents:source,resolveDir:path.join(process.cwd(),'src/renderer/src/shared/services'),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
let now=0,next=0,active=0,peak=0,calls=0;const timers=new Map(),pending=[]
global.setTimeout=(fn,delay)=>{const id=++next;timers.set(id,{at:now+delay,fn});return id};global.clearTimeout=id=>timers.delete(id);global.window={};global.document={visibilityState:'visible'}
global.fetch=async()=>{active++;calls++;peak=Math.max(peak,active);return new Promise(resolve=>pending.push(()=>{active--;resolve(new Response('{}',{status:200}))}))}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
const advance=async target=>{await flush();while(true){let task;for(const pair of timers)if(pair[1].at<=target&&(!task||pair[1].at<task[1].at))task=pair;if(!task)break;timers.delete(task[0]);now=task[1].at;task[1].fn();await flush()}now=target;await flush()}
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
;(async()=>{for(let i=0;i<6;i++){const t=i*500,event={};m.exports.attachCaptionTiming(event,{speechAt:t,detectedAt:t+120,queuedAt:t+200,dequeuedAt:t+210,requestAt:t+220,responseAt:t+400});m.exports.registerCaptionTiming(String(i),event);m.exports.reportCaptionPaint([String(i)],t+450);await advance((i+1)*500)}
 const result={delayWindowMs:3000,calls,inflight:active,peak};fs.writeFileSync(path.join(__dirname,'results/'+mode+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));for(const release of pending)release();await flush()
})().catch(e=>{console.error(e);process.exitCode=1})
