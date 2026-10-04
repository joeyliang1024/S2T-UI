const fs=require('node:fs'),path=require('node:path');
const repo='/Users/liangzhiquan/Desktop/S2T-UI',out=path.resolve(__dirname,'../../outputs/diarization');process.chdir(repo);
const api=require(path.join(repo,'server/sherpa-diarization.cjs'));
const id=process.argv[2]||'ldnro',mode=process.argv[3]||'full';
const audio=fs.readFileSync(path.join(repo,'tmp/voxconverse/wav/audio',id+'.wav'));
const wav=api.readWavSamples(audio),duration=wav.samples.length/wav.sampleRate;
const truth=fs.readFileSync(path.join(repo,'tmp/voxconverse/annotations/dev',id+'.rttm'),'utf8').trim().split('\n').map(line=>{const x=line.split(/\s+/);return {start:+x[3],end:+x[3]+ +x[4],speaker:x[7]}});
function toWav(samples){const b=Buffer.alloc(44+samples.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(wav.sampleRate,24);b.writeUInt32LE(wav.sampleRate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples.length*2,40);for(let i=0;i<samples.length;i++)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(samples[i]*32768))),44+i*2);return b}
if(mode==='full'){
 const thresholds=process.argv[4]?[Number(process.argv[4])]:[.8,.75,.85];const results=[];
 for(const threshold of thresholds){process.env.S2T_SHERPA_CLUSTERING_THRESHOLD=String(threshold);const start=performance.now();const turns=api.diarizeWav(audio);const elapsedMs=performance.now()-start;results.push({threshold,turns,elapsedMs,rssMB:process.memoryUsage().rss/1048576});fs.writeFileSync(path.join(out,id+'-full.json'),JSON.stringify({id,duration,truth,results}));console.log(JSON.stringify({id,mode,threshold,seconds:elapsedMs/1000,count:new Set(turns.map(x=>x.speaker)).size}));}
}else{
 const ticks=[];delete process.env.S2T_SHERPA_CLUSTERING_THRESHOLD;
 const endpoints=[];for(let e=30;e<duration;e+=30)endpoints.push(e);endpoints.push(duration);
 for(const endSec of endpoints){const startSec=Math.max(0,endSec-45);const clip=toWav(wav.samples.subarray(Math.floor(startSec*wav.sampleRate),Math.floor(endSec*wav.sampleRate)));const begin=performance.now();const local=api.diarizeWav(clip);const inferenceMs=performance.now()-begin;const embedStart=performance.now();const embeddings=api.extractSpeakerLabelEmbeddings(clip,local);const embeddingMs=performance.now()-embedStart;
 ticks.push({startSec,endSec,turns:local.map(t=>({...t,start:t.start+startSec,end:t.end+startSec})),embeddings,inferenceMs,embeddingMs});fs.writeFileSync(path.join(out,id+'-preview.json'),JSON.stringify({id,totalSec:duration,truth,ticks,windowSec:45,tickSec:30,origin:'fresh production local inference; no ASR'}));console.log(JSON.stringify({id,mode,endSec,inferenceMs,embeddingMs,count:Object.keys(embeddings).length}));}
}
