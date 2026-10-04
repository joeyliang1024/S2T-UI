from pathlib import Path
import subprocess,time,json,sys
root=Path(__file__).resolve().parents[2];out=root/'outputs/diarization';repo=Path('/Users/liangzhiquan/Desktop/S2T-UI');exe=root/'work/diarization/nemo-runtime/nemo-speech-0.2.0-macos-aarch64-cpu/bin/nemo-speech';model=root/'work/diarization/Nemotron-3-Diarization.q8_0.gguf'
subprocess.run(['node',str(root/'work/diarization/native.cjs'),'qouur','full','0.8'],check=True,cwd=root)
subprocess.run([sys.executable,str(root/'work/diarization/nemotron-run.py'),'qouur','jcako-repeat4'],check=True,cwd=root)
for id,suffix,flags in [('jcako','v3-offline-pad005',['--pad-onset','0.05','--pad-offset','0.05']),('hkzpa','v3-offline-pad005',['--pad-onset','0.05','--pad-offset','0.05']),('jcako','v3-offline-repeat',[])]:
 command=[str(exe),'diarize',str(repo/'tmp/voxconverse/wav/audio'/f'{id}.wav'),'--model',str(model),'--backend','cpu','--preset','v3-offline','--format','rttm','--recording-id',id,'--output',str(out/f'{id}-nemotron-{suffix}.rttm')]+flags
 begin=time.monotonic()
 with (out/f'{id}-nemotron-{suffix}.log').open('w') as log:p=subprocess.run(command,stdout=log,stderr=log,timeout=900)
 info={'id':id,'preset':suffix,'elapsedMs':(time.monotonic()-begin)*1000,'returncode':p.returncode,'command':command,'runtime':'NVIDIA official NeMo-Speech.cpp v0.2.0 macos-aarch64-cpu','model':'Nemotron 3 Diarization q8_0','audioEgress':False,'pacedRealtime':False}
 (out/f'{id}-nemotron-{suffix}.metadata.json').write_text(json.dumps(info,indent=2));print(json.dumps(info),flush=True)
