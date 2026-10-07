const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{buildSync}=require('esbuild');
const root=path.resolve(__dirname,'../../..');
function load(base){const code=buildSync({entryPoints:[path.join(base,'src/renderer/src/features/app/services/translation-queue.ts')],bundle:true,platform:'node',format:'cjs',write:false,nodePaths:[path.join(root,'node_modules')]}).outputFiles[0].text;const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require);return m.exports.TranslationQueue;}
global.window={setTimeout,clearTimeout};
const modules={main:load(process.env.S2T_MAIN_SNAPSHOT||'/tmp/s2t-translation-main-20261007'),feature:load(root)};
async function run(Queue,strategy,latency){let now=0,entries=[],scheduled=[],calls=[],completions=new Map();
const queue=new Queue(()=>entries,update=>{entries=update(entries);for(const e of entries)if(e.translationStatus==='completed'&&!completions.has(e.id))completions.set(e.id,now)},error=>{throw new Error(error)},()=>now,ms=>new Promise(resolve=>scheduled.push({at:now+ms,resolve})));
const fixtures=Array.from({length:24},(_,i)=>({id:'http-'+i,revision:1,status:'final',startMs:i*1200,endMs:(i+1)*1200,sourceText:['We tested the database',' after a rolling update',' and all accounts',' retained their recordings.'][i%4],detectedLanguage:'en-US',isSentenceBoundary:i%4===3}));
let next=0;for(now=0;now<=60000;now+=50){while(next<fixtures.length&&fixtures[next].endMs+500<=now){entries.push({...fixtures[next++]})}
 const due=scheduled.filter(s=>s.at<=now);scheduled=scheduled.filter(s=>s.at>now);due.forEach(s=>s.resolve());await Promise.resolve();await Promise.resolve();await Promise.resolve();
 queue.tick({strategy,targetLanguage:'zh-TW',elapsedMs:now},(entry,signal)=>new Promise(resolve=>{calls.push({at:now,text:entry.sourceText,id:entry.id});scheduled.push({at:now+latency,resolve:()=>resolve('mock:'+entry.sourceText)})}));await Promise.resolve();
 if(next===fixtures.length&&entries.every(e=>e.translationStatus==='completed')&&!queue.inFlight)break;
}
const requested=calls.map(c=>c.text).join('').replace(/\s/g,'');const expected=fixtures.map(c=>c.sourceText).join('').replace(/\s/g,'');
const delays=fixtures.map(e=>(completions.get(e.id)??NaN)-(e.endMs+500)).filter(Number.isFinite).sort((a,b)=>a-b);assert.equal(completions.size,24);
return{strategy,mockModelLatencyMs:latency,requests:calls.length,completed:completions.size,sourceCoverageExact:requested===expected,charsPerRequest:calls.map(c=>c.text.length),requestInputs:calls,captionToTranslationMs:{p50:delays[Math.floor(delays.length*.5)],p95:delays[Math.floor(delays.length*.95)],max:delays.at(-1)},peakConcurrent:queue.diagnostics.peakConcurrent};}
(async()=>{const results=[];for(const strategy of ['realtime','sentence'])for(const latency of [180,800,2500])for(const [branch,Queue]of Object.entries(modules))results.push({branch,...await run(Queue,strategy,latency)});fs.writeFileSync(path.join(__dirname,'queue-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results.map(({requestInputs,charsPerRequest,...r})=>r),null,2));})().catch(e=>{console.error(e);process.exitCode=1});
