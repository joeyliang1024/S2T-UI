from pathlib import Path
import json,hashlib,wave
root=Path(__file__).resolve().parents[2];out=root/'outputs/diarization';repo=Path('/Users/liangzhiquan/Desktop/S2T-UI');sources=[]
for id in ['jcako','hkzpa','ldnro','qouur']:
 for kind,p in [('wav',repo/'tmp/voxconverse/wav/audio'/f'{id}.wav'),('rttm',repo/'tmp/voxconverse/annotations/dev'/f'{id}.rttm')]:
  h=hashlib.sha256()
  with p.open('rb') as f:
   for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
  row={'id':id,'kind':kind,'path':str(p),'sha256':h.hexdigest(),'bytes':p.stat().st_size}
  if kind=='wav':
   with wave.open(str(p)) as w:row.update(sampleRate=w.getframerate(),channels=w.getnchannels(),seconds=w.getnframes()/w.getframerate())
  sources.append(row)
(out/'input-provenance.json').write_text(json.dumps({'sources':sources,'referenceVersionNote':'local VoxConverse annotation README says v0.3; hashes pin actual files used','originalFilesModified':False},indent=2))
print('Provenance saved',len(sources),'inputs')
