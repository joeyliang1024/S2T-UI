const assert=require('node:assert/strict'),{buildSync}=require('esbuild')
const code=buildSync({stdin:{contents:"export * from './src/renderer/src/shared/services/caption-metric-transport'",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,require)
const {CaptionMetricTransport}=m.exports
class Clock{
 constructor(){this.now=0;this.id=0;this.tasks=new Map()}
 install(){global.setTimeout=(fn,delay)=>{const id=++this.id;this.tasks.set(id,{at:this.now+delay,fn});return id};global.clearTimeout=id=>this.tasks.delete(id)}
 async flush(){for(let i=0;i<20;i++)await Promise.resolve()}
 async advance(target){await this.flush();while(true){let task;for(const pair of this.tasks)if(pair[1].at<=target&&(!task||pair[1].at<task[1].at))task=pair;if(!task)break;this.tasks.delete(task[0]);this.now=task[1].at;task[1].fn();await this.flush()}this.now=target;await this.flush()}
}
const batch=id=>Array.from({length:13},(_,i)=>({stage:i<6?'first_word_'+['vad_onset','chunk_wait','browser_queue','browser_preprocess','asr_roundtrip_with_retries','response_to_paint'][i]:'response_to_paint',seconds:id}))
;(async()=>{
 const clock=new Clock();clock.install();let active=0,peak=0;const sent=[],releases=[]
 const transport=new CaptionMetricTransport(async payload=>{active++;peak=Math.max(peak,active);sent.push(payload);return new Promise(resolve=>releases.push(ok=>{active--;resolve(ok)}))},()=>clock.now)
 for(let i=1;i<=30;i++){transport.enqueue(batch(i));await clock.advance(i*500);assert.ok(transport.snapshot().queuedSamples<=128)}
 assert.equal(sent.length,1);assert.equal(peak,1);assert.equal(transport.snapshot().queuedSamples,117)
 releases.shift()(true);await clock.advance(15500);assert.equal(sent.length,2)
 const grouped=new Map();for(const sample of sent[1].samples)grouped.set(sample.seconds,(grouped.get(sample.seconds)||0)+1)
 assert.ok([...grouped.values()].every(count=>count===13),'drop complete cohorts, never arbitrary slices')
 assert.equal(sent[1].events.telemetry_dropped,20)
 releases.shift()(true);await clock.advance(20000);assert.equal(transport.snapshot().inFlight,false);assert.equal(clock.tasks.size,0)
 const failureClock=new Clock();failureClock.install();const failedPayloads=[]
 const failed=new CaptionMetricTransport(async payload=>{failedPayloads.push(payload);return false},()=>failureClock.now)
 failed.enqueue(batch(1));await failureClock.advance(500);assert.equal(failedPayloads.length,1)
 await failureClock.advance(1500);assert.equal(failedPayloads.length,2);assert.equal(failedPayloads[1].samples.length,0)
 await failureClock.advance(60000);assert.equal(failedPayloads.length,2,'idle outage must stop after one notification')
 failed.enqueue(batch(2));await failureClock.advance(60500);assert.equal(failedPayloads.length,3);assert.equal(failedPayloads[2].samples[0].seconds,2,'failed histograms are not replayed')
 assert.equal(failedPayloads[2].events.telemetry_dropped,2)
 const burstClock=new Clock();burstClock.install();const bursts=[]
 const burst=new CaptionMetricTransport(async payload=>{bursts.push(payload);return true},()=>burstClock.now)
 for(let i=0;i<1600;i++)burst.enqueue([],'audio_gap')
 await burstClock.advance(500);assert.equal(bursts[0].events.audio_gap,1000);assert.equal(bursts[0].events.telemetry_dropped,600)
 console.log('PASS one inflight request, bounded complete-cohort buffering, capped event counts, failure backoff, final drop notification and no idle outage polling or histogram replay')
})().catch(e=>{console.error(e);process.exitCode=1})
