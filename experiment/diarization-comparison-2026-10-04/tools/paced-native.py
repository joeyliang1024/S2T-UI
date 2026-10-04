from pathlib import Path
import ctypes as C, json, time, wave, numpy as np
root=Path(__file__).resolve().parents[2];runtime=root/'work/diarization/nemo-runtime/nemo-speech-0.2.0-macos-aarch64-cpu';out=root/'outputs/diarization';repo=Path('/Users/liangzhiquan/Desktop/S2T-UI')
lib=C.CDLL(str(runtime/'lib/libnemo_speech_asr_c.1.dylib'))
class ModelConfig(C.Structure):
 _fields_=[('size',C.c_size_t),('model_path',C.c_char_p),('gpu',C.c_int32),('preset',C.c_char_p),('chunk_frames',C.c_int32),('right_context_frames',C.c_int32),('left_context_frames',C.c_int32),('fifo_frames',C.c_int32),('spkcache_frames',C.c_int32),('update_period_frames',C.c_int32)]
class Segment(C.Structure):
 _fields_=[('start_time',C.c_double),('end_time',C.c_double),('speaker',C.c_int32)]
P=C.c_void_p
lib.nemo_speech_asr_last_error.restype=C.c_char_p
lib.nemo_speech_diar_create.argtypes=[C.POINTER(ModelConfig),C.POINTER(P)]
lib.nemo_speech_diar_stream_open.argtypes=[P,C.POINTER(P)]
lib.nemo_speech_diar_stream_push_f32.argtypes=[P,C.POINTER(C.c_float),C.c_size_t,C.c_int32]
lib.nemo_speech_diar_frame_count.argtypes=[P];lib.nemo_speech_diar_frame_count.restype=C.c_int64
lib.nemo_speech_diar_seconds_per_frame.argtypes=[P];lib.nemo_speech_diar_seconds_per_frame.restype=C.c_double
lib.nemo_speech_diar_segments.argtypes=[P,P,C.POINTER(Segment),C.c_size_t,C.POINTER(C.c_size_t)]
lib.nemo_speech_diar_stream_finish.argtypes=[P]
lib.nemo_speech_diar_stream_close.argtypes=[P]
lib.nemo_speech_diar_destroy.argtypes=[P]
def ok(status):
 if status:raise RuntimeError(lib.nemo_speech_asr_last_error().decode())
def segments(stream):
 n=C.c_size_t();ok(lib.nemo_speech_diar_segments(stream,None,None,0,C.byref(n)));a=(Segment*n.value)();ok(lib.nemo_speech_diar_segments(stream,None,a,n.value,C.byref(n)));return [{'start':s.start_time,'end':s.end_time,'speaker':f'speaker_{s.speaker}'} for s in a]
with wave.open(str(repo/'tmp/voxconverse/wav/audio/jcako.wav')) as w:
 rate=w.getframerate();channels=w.getnchannels();audio=np.frombuffer(w.readframes(rate*60),dtype='<i2').reshape(-1,channels).mean(axis=1).astype('float32')/32768
model=P();stream=P();modelpath=str(root/'work/diarization/Nemotron-3-Diarization.q8_0.gguf').encode();config=ModelConfig();config.size=C.sizeof(config);config.model_path=modelpath;config.gpu=-1;config.preset=b'v3-streaming';config.left_context_frames=-1
init=time.monotonic();ok(lib.nemo_speech_diar_create(C.byref(config),C.byref(model)));loadMs=(time.monotonic()-init)*1000;ok(lib.nemo_speech_diar_stream_open(model,C.byref(stream)));step=round(rate*.02);cadence=lib.nemo_speech_diar_seconds_per_frame(model);events=[];start=time.monotonic();first=None;lastFrames=0;pushTimes=[];waitLate=[]
try:
 for index in range(0,len(audio),step):
  end=min(len(audio),index+step);scheduled=end/rate;remaining=start+scheduled-time.monotonic()
  if remaining>0:time.sleep(remaining)
  lateness=max(0,time.monotonic()-start-scheduled);waitLate.append(lateness*1000)
  begin=time.monotonic();ptr=audio[index:end].ctypes.data_as(C.POINTER(C.c_float));ok(lib.nemo_speech_diar_stream_push_f32(stream,ptr,end-index,rate));pushTimes.append((time.monotonic()-begin)*1000)
  frames=lib.nemo_speech_diar_frame_count(stream)
  if frames>lastFrames:
   elapsed=time.monotonic()-start
   if first is None:first=elapsed*1000
   events.append({'audioFedSeconds':scheduled,'wallSeconds':elapsed,'frames':frames,'labelledThroughSeconds':frames*cadence,'lagMs':(elapsed-frames*cadence)*1000,'turns':segments(stream)})
   lastFrames=frames
   if len(events)%40==0:print('paced',round(scheduled,2),'seconds',flush=True)
 finish=time.monotonic();ok(lib.nemo_speech_diar_stream_finish(stream));tailMs=(time.monotonic()-finish)*1000;final=segments(stream)
 result={'id':'jcako','seconds':60,'pacedRealtime':True,'frameInputMs':20,'modelLoadMs':loadMs,'firstFrameOutputWallMs':first,'nativeFrameCadenceSeconds':cadence,'pushCallP50Ms':float(np.percentile(pushTimes,50)),'pushCallP95Ms':float(np.percentile(pushTimes,95)),'pushCallMaxMs':max(pushTimes),'feedLatenessP95Ms':float(np.percentile(waitLate,95)),'labelledAudioLagP50Ms':float(np.percentile([e['lagMs'] for e in events],50)),'labelledAudioLagP95Ms':float(np.percentile([e['lagMs'] for e in events],95)),'tailFlushMs':tailMs,'wallSeconds':time.monotonic()-start,'events':events,'turns':final,'noASRConcurrent':True,'note':'frame/probability output availability, not confirmed identity or subtitle render latency'}
 (out/'jcako-paced60.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ['events','turns']}),flush=True)
finally:
 lib.nemo_speech_diar_stream_close(stream);lib.nemo_speech_diar_destroy(model)
