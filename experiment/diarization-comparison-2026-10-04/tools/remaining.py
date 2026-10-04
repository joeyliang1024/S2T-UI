from pathlib import Path
import subprocess,sys,json,time
root=Path(__file__).resolve().parents[2];out=root/'outputs/diarization';node='node';python=sys.executable
jobs=[
 ['node',str(root/'work/diarization/native.cjs'),'jcako','full','0.8'],
 ['node',str(root/'work/diarization/native.cjs'),'jcako','preview'],
 ['node',str(root/'work/diarization/embed.cjs'),'ldnro'],
 [str(root/'work/diarization/metric-venv/bin/python'),str(root/'work/diarization/spectral.py'),'ldnro'],
 ['node',str(root/'work/diarization/embed.cjs'),'jcako'],
 [str(root/'work/diarization/metric-venv/bin/python'),str(root/'work/diarization/spectral.py'),'jcako'],
 ['node',str(root/'work/diarization/native.cjs'),'hkzpa','full','0.8'],
 [python,str(root/'work/diarization/nemotron-run.py'),'hkzpa','ldnro'],
 [str(root/'work/diarization/metric-venv/bin/python'),str(root/'work/diarization/paced-native.py')],
 ['node',str(root/'work/diarization/compare.cjs')],
 ['node',str(root/'work/diarization/score-final.cjs')],
 [str(root/'work/diarization/metric-venv/bin/python'),str(root/'work/diarization/verify-metrics.py')]
]
results=[]
for index,job in enumerate(jobs):
 print('START',index,job,flush=True);begin=time.monotonic()
 p=subprocess.run(job,cwd=root,timeout=2400);results.append({'index':index,'command':job,'returncode':p.returncode,'elapsedSeconds':time.monotonic()-begin})
 (out/'experiment-jobs.json').write_text(json.dumps(results,indent=2))
 print('DONE',index,p.returncode,flush=True)
 if p.returncode:print('Job failed; later independent experiments continue',flush=True)
