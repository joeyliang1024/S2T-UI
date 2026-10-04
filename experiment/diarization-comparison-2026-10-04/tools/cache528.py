from pathlib import Path
import ctypes as C,time,json,numpy as np,wave
root=Path(__file__).resolve().parents[2];out=root/'outputs/diarization';code=(root/'work/diarization/paced-native.py').read_text();setup=code[:code.index('with wave.open')];exec(setup)
config=ModelConfig();config.size=C.sizeof(config);config.model_path=str(root/'work/diarization/Nemotron-3-Diarization.q8_0.gguf').encode();config.gpu=-1;config.preset=b'v3-offline';config.left_context_frames=-1;config.spkcache_frames=528
model=P();stream=P();begin=time.monotonic();ok(lib.nemo_speech_diar_create(C.byref(config),C.byref(model)));ok(lib.nemo_speech_diar_stream_open(model,C.byref(stream)))
with wave.open(str(root/'work/diarization/jcako-repeat4.wav')) as w:
 rate=w.getframerate();audio=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype('float32')/32768
try:
 step=rate*30
 for i in range(0,len(audio),step):
  part=audio[i:i+step];ok(lib.nemo_speech_diar_stream_push_f32(stream,part.ctypes.data_as(C.POINTER(C.c_float)),len(part),rate))
 ok(lib.nemo_speech_diar_stream_finish(stream));turns=segments(stream);elapsedMs=(time.monotonic()-begin)*1000
 file=out/'jcako-repeat4-nemotron-v3-offline-cache528.rttm';file.write_text('\n'.join(f"SPEAKER jcako-repeat4 1 {t['start']:.6f} {t['end']-t['start']:.6f} <NA> <NA> {t['speaker']} <NA> <NA>" for t in turns)+'\n')
 (out/'jcako-repeat4-nemotron-v3-offline-cache528.metadata.json').write_text(json.dumps({'id':'jcako-repeat4','preset':'v3-offline','spkcache_frames':528,'baselineSpkcacheFrames':264,'elapsedMs':elapsedMs,'returncode':0,'api':'official C ABI, native stream, unpaced full-file push','pacedRealtime':False,'audioEgress':False},indent=2));print('cache528 completed',elapsedMs/1000,'seconds',len(set(t['speaker'] for t in turns)),'labels',flush=True)
finally:
 lib.nemo_speech_diar_stream_close(stream);lib.nemo_speech_diar_destroy(model)
