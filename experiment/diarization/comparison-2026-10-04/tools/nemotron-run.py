from pathlib import Path
import subprocess,time,json,os
root=Path(__file__).resolve().parents[2]
exe=root/'work/diarization/nemo-runtime/nemo-speech-0.2.0-macos-aarch64-cpu/bin/nemo-speech'
model=root/'work/diarization/Nemotron-3-Diarization.q8_0.gguf'
repo=Path('/Users/liangzhiquan/Desktop/S2T-UI')
out=root/'outputs/diarization'
import sys
ids=sys.argv[1:] or ['jcako','ldnro']
for id in ids:
 for preset in (['v3-offline'] if id in ['jcako-repeat4','qouur'] else ['v3-streaming','v3-offline']):
  dest=out/f'{id}-nemotron-{preset}.rttm'
  command=[str(exe),'diarize',str(root/'work/diarization'/f'{id}.wav') if (root/'work/diarization'/f'{id}.wav').exists() else str(repo/'tmp/voxconverse/wav/audio'/f'{id}.wav'),'--model',str(model),'--backend','cpu','--preset',preset,'--format','rttm','--recording-id',id,'--output',str(dest)]
  start=time.monotonic()
  with (out/f'{id}-nemotron-{preset}.log').open('w') as log:
   p=subprocess.run(command,stdout=log,stderr=log,timeout=1800,env={**os.environ,'HF_HOME':str(root/'work/diarization/hf-cache'),'XDG_CACHE_HOME':str(root/'work/diarization/runtime-cache')})
  info={'id':id,'preset':preset,'elapsedMs':(time.monotonic()-start)*1000,'returncode':p.returncode,'command':command,'runtime':'NVIDIA official NeMo-Speech.cpp v0.2.0 macos-aarch64-cpu','model':'Nemotron 3 Diarization q8_0','audioEgress':False,'pacedRealtime':False}
  (out/f'{id}-nemotron-{preset}.metadata.json').write_text(json.dumps(info,indent=2))
  print(json.dumps(info),flush=True)
  if p.returncode:print((out/f'{id}-nemotron-{preset}.log').read_text()[-2000:],flush=True)
