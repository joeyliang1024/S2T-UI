import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { pcm16, makeWav } from '../../frontend/src/shared/services/audio'
import { BufferedPcmWriter, pcmRecordingBufferLimits } from '../../frontend/src/features/capture/recording/buffered-writer'
import { OpfsPcmRecording } from '../../frontend/src/features/capture/recording/adapters/opfs-pcm-recording'
import { CorrectionAudioBuffer, correctionGroups, applySentenceCorrection } from '../../frontend/src/features/transcript/services/quality-correction'
import { captionGroupSignature, upsertLiveCaption, renderedLiveCaptionWindow } from '../../frontend/src/features/transcript/domain/live-caption'
import { createOpenAiChunkedModelAdapter } from '../../frontend/src/features/models/model-adapter'
import { StreamingResampler } from '../../frontend/src/features/capture/resample'
import { CaptionPaintMetric } from '../../frontend/src/features/captions/views/CaptionPaintMetric'
import { installCorrection, pushPreview } from './recording-stress-production.generated'

const config = window.stressConfig
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const percentile = (values, fraction = .95) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1] : null
let entries = [], publish = () => {}, fatal = null, paused = false, stopped = false
function View() {
  const [, setVersion] = useState(0)
  useEffect(()=>{publish=()=>setVersion(v=>v+1);return()=>{publish=()=>{}}},[])
  return <section className="transcript">{renderedLiveCaptionWindow(entries).map(entry=><article key={entry.id}><CaptionPaintMetric members={[entry]} text={entry.sourceText}/></article>)}</section>
}
createRoot(document.getElementById('root')).render(<View/> )
window.stressResult = null
window.stressProgress = { stage:'starting' }
const main = async () => {
  const context = new AudioContext({ sampleRate: config.sampleRate })
  const rate = context.sampleRate
  const recording = await OpfsPcmRecording.create(`pressure-stress-${crypto.randomUUID()}`, rate)
  if (!recording) throw new Error('Real OPFS unavailable')
  const marks = [], writeMs = [], opfsWriteMs = [], frameMs = [], longTasks = [], heap = [], checksums = [], pressures = [], errors = []
  const started = performance.now()
  const ref = current => ({current})
  const correctionAudio = new CorrectionAudioBuffer(16000)
  const correctionContext = {liveCorrectionAudioRef:ref(correctionAudio),activeModelSnapshotRef:ref({id:'stress',model:'mock',kind:'openai-http',sourceLanguage:'zh-TW',prompt:''}),
    isFloatingCaptionWindow:false,liveCorrectionBusyRef:ref(false),captureState:'recording',liveCorrectionEpochRef:ref(1),continuationTargetRef:ref(null),transcriptsRef:ref(entries),
    liveCorrectionDoneRef:ref(new Set()),liveCorrectionFailuresRef:ref(new Map()),liveCorrectionRunnerRef:ref(null),correctionGroups,captionGroupSignature,selectedModel:{},makeWav,applySentenceCorrection,
    transcribeCorrection:async audio=>{const response=await fetch('/api/correction',{method:'POST',body:audio});return response.json()},
    setTranscripts:update=>{entries=update(entries);correctionContext.transcriptsRef.current=entries;publish()},setStatus:message=>errors.push(message),activeTranslate:key=>key}
  installCorrection(correctionContext)
  const preview = {sampleRateRef:ref(rate),liveDiarizationChunksRef:ref([]),liveDiarizationHeadRef:ref(0),liveDiarizationSamplesRef:ref(0),liveDiarizationStartSampleRef:ref(0)}
  const adapter = createOpenAiChunkedModelAdapter({id:'stress',endpoint:'/api/transcriptions',model:'mock',gatewayProfileId:'default',requiresApiKey:false})
  adapter.onError(message=>{fatal=message})
  adapter.onTranscript(event=>{entries=upsertLiveCaption(entries,event,-1,()=>false);correctionContext.transcriptsRef.current=entries;publish()})
  await adapter.start({sampleRate:16000,language:'zh-TW',targetLanguage:'en'})
  const resampler = new StreamingResampler(rate,16000)
  let acceptedSamples=0, inputSamples=0, calls=0, processedFrames=0, framePeak=0, pendingPeak=0, bufferedPeak=0, snapshotPeak=0, processingSum=0
  let pauseAt=null, pausedMs=0, correctionChecks=0
  const limits = config.legacy ? {batchBytes:24000,maximumPendingBytes:192000} : pcmRecordingBufferLimits(rate)
  const writer = new BufferedPcmWriter(async audio=>{
    const begin=performance.now(), elapsed=begin-started, n=++calls
    let delay=0
    if (config.delay==='burst' && Math.floor(elapsed/30000)>Math.floor((marks.at(-1)?.elapsed??0)/30000)) delay=3000
    if (config.delay==='sustained' && elapsed>=60000 && !marks.some(mark=>mark.delay===10000)) delay=10000
    marks.push({elapsed,delay})
    if(delay) await sleep(delay)
    const diskStart=performance.now();await recording.append(audio);opfsWriteMs.push(performance.now()-diskStart)
    writeMs.push(performance.now()-begin)
    const digest=await crypto.subtle.digest('SHA-256',audio);checksums.push({bytes:audio.byteLength,hash:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')})
  },active=>{
    pressures.push({active,atMs:performance.now()-started,pendingBytes:writer.pendingBytes})
    paused=active
    if(active)pauseAt=performance.now()
    else if(pauseAt!==null){pausedMs+=performance.now()-pauseAt;pauseAt=null}
  },error=>{fatal=error.message},limits.batchBytes,limits.maximumPendingBytes)
  const observer = new PerformanceObserver(list=>{for(const task of list.getEntries())longTasks.push({atMs:task.startTime-started,durationMs:task.duration})})
  observer.observe({type:'longtask',buffered:true})
  await context.audioWorklet.addModule('/capture.worklet.js')
  const processor=new AudioWorkletNode(context,'s2t-audio-capture',{numberOfInputs:1,numberOfOutputs:1,channelCount:1,channelCountMode:'explicit'})
  const source=context.createOscillator();source.frequency.value=180
  const level=context.createGain();level.gain.value=.05
  const silent=context.createGain();silent.gain.value=0
  source.connect(level);level.connect(processor);processor.connect(silent);silent.connect(context.destination)
  processor.port.onmessage=event=>{
    if(stopped)return
    const samples=new Float32Array(event.data);inputSamples+=samples.length
    if(paused)return
    const begin=performance.now()
    writer.push(pcm16(samples));acceptedSamples+=samples.length
    pushPreview(preview,samples)
    const modelSamples=resampler.process(samples)
    if(modelSamples.length){correctionAudio.push(modelSamples);adapter.pushAudio(modelSamples,correctionAudio.samples-modelSamples.length)}
    const duration=performance.now()-begin;if(processedFrames++%32===0)frameMs.push(duration);framePeak=Math.max(framePeak,duration);processingSum+=duration
    pendingPeak=Math.max(pendingPeak,writer.pendingBytes);bufferedPeak=Math.max(bufferedPeak,writer.pendingBytes+(writer.writing?rate:0))
  }
  source.start();await context.resume()
  let heartbeatExpected=performance.now()+100, heartbeats=[]
  const heartbeat=setInterval(()=>{const now=performance.now();heartbeats.push(Math.max(0,now-heartbeatExpected));heartbeatExpected=now+100},100)
  const correction=setInterval(()=>{correctionChecks++;if(!paused)void correctionContext.liveCorrectionRunnerRef.current()},1000)
  const renderTimer=setInterval(()=>publish(),250)
  const previewTimer=setInterval(()=>{
    const chunks=preview.liveDiarizationChunksRef.current.slice(preview.liveDiarizationHeadRef.current)
    if(chunks.length){const begin=performance.now();makeWav(chunks,rate);snapshotPeak=Math.max(snapshotPeak,performance.now()-begin)}
  },5000)
  const monitor=setInterval(()=>{
    const progress={stage:'recording',name:config.name,correctionChecks,candidateCount:correctionGroups(entries).length,doneCount:correctionContext.liveCorrectionDoneRef.current.size,busy:correctionContext.liveCorrectionBusyRef.current,captions:entries.length,asrRequests:adapter.diagnostics.requests,correctionSamples:correctionAudio.samples,errors:errors.slice(-2),fatal,seconds:Math.round((performance.now()-started)/1000),acceptedSeconds:acceptedSamples/rate,pendingSeconds:writer.pendingBytes/(rate*2),pauses:pressures.filter(x=>x.active).length,heapBytes:performance.memory?.usedJSHeapSize??null,frameP95Ms:percentile(frameMs),longTaskCount:longTasks.length,corrected:entries.filter(entry=>entry.correctionOriginalText!==undefined).length}
    heap.push(progress);window.stressProgress=progress
  },5000)
  await sleep(config.durationMs)
  stopped=true;source.stop();processor.port.onmessage=null
  clearInterval(heartbeat);clearInterval(correction);clearInterval(renderTimer);clearInterval(previewTimer);clearInterval(monitor)
  correctionContext.liveCorrectionEpochRef.current++
  processor.disconnect();level.disconnect();silent.disconnect();await context.close()
  const tail=resampler.flush();if(tail.length)adapter.pushAudio(tail,correctionAudio.samples)
  await adapter.stop();await writer.closeAndDrain()
  const wav=await recording.finish()
  const header=new DataView(await wav.slice(0,44).arrayBuffer())
  let byteOffset=44, integrity=true
  for(const chunk of checksums){const digest=await crypto.subtle.digest('SHA-256',await wav.slice(byteOffset,byteOffset+chunk.bytes).arrayBuffer());const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');if(hash!==chunk.hash)integrity=false;byteOffset+=chunk.bytes}
  await recording.discard();observer.disconnect()
  const pauses=pressures.filter(x=>x.active).length,resumes=pressures.filter(x=>!x.active).length
  const modelSampleCount=correctionAudio.samples+tail.length
  const expectedModelSamples=Math.round(acceptedSamples/rate*16000)
  const timelineAligned=modelSampleCount===expectedModelSamples
  const audioIntact=integrity&&wav.size===44+acceptedSamples*2&&header.getUint32(40,true)===acceptedSamples*2&&byteOffset===wav.size
  const correctedCount=entries.filter(entry=>entry.correctionOriginalText!==undefined).length
  const responsive=percentile(heartbeats)<100&&Math.max(...heartbeats)<1000
  const heapPeak=Math.max(...heap.map(sample=>sample.heapBytes??0))
  const memoryWithinBudget=heapPeak<256*1024*1024
  const passed=timelineAligned&&responsive&&memoryWithinBudget&&!fatal&&errors.length===0&&audioIntact&&entries.every(entry=>entry.status!=='gap')&&(config.durationMs<45000||correctedCount>0)&&pauses===resumes&&(config.expectPauses?pauses>0:pauses===0)
  window.stressResult={...config,passed,actualSampleRate:rate,elapsedMs:performance.now()-started,acceptedSeconds:acceptedSamples/rate,inputSeconds:inputSamples/rate,pauses,resumes,pausedMs,
    audioIntact,timelineAligned,modelSampleCount,expectedModelSamples,responsive,memoryWithinBudget,heapPeak,acceptance:{heartbeatP95Ms:100,heartbeatMaxMs:1000,heapPeakBytes:256*1024*1024},audioBytes:wav.size,writeCalls:calls,injectedStalls:marks.filter(mark=>mark.delay),writeP95Ms:percentile(writeMs),opfsWriteP95Ms:percentile(opfsWriteMs),opfsWriteMaxMs:Math.max(...opfsWriteMs),
    frameP95Ms:percentile(frameMs),frameMaxMs:framePeak,processingMsPerAudioSecond:processingSum/(acceptedSamples/rate),heartbeatP95Ms:percentile(heartbeats),heartbeatMaxMs:Math.max(...heartbeats),
    previewSnapshotMaxMs:snapshotPeak,pendingPeakSeconds:pendingPeak/(rate*2),longTasks,heapSamples:heap,captions:entries.length,corrected:entries.filter(entry=>entry.correctionOriginalText!==undefined).length,
    gaps:entries.filter(entry=>entry.status==='gap').length,pressures,fatal,errors,limits,method:'Real Chrome AudioContext/AudioWorklet and real OPFS; synthetic oscillator input; local mock ASR/correction. Production writer, resampler, model adapter, correction runner, preview retention and React Highlight.'}
}
main().catch(error=>{window.stressResult={...config,passed:false,fatal:error.stack||String(error)}})
