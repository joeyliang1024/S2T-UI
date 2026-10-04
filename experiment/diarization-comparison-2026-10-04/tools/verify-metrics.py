from pathlib import Path
import json
from pyannote.core import Annotation,Segment,Timeline
from pyannote.metrics.diarization import DiarizationErrorRate
out=Path(__file__).resolve().parents[2]/'outputs/diarization'
data=json.loads((out/'final-comparison.json').read_text());rows=[]
def ann(turns):
 a=Annotation()
 for i,t in enumerate(turns):a[Segment(t['start'],t['end']),str(i)]=t['speaker']
 return a.support()
for id,d in data['datasets'].items():
 for name,m in d['methods'].items():
  metric=DiarizationErrorRate(collar=0,skip_overlap=False)
  detail=metric(ann(d['truth']),ann(m['turns']),uem=Timeline([Segment(0,d['duration'])]),detailed=True)
  js=m['metrics']['DER'];official=detail['diarization error rate']*100
  rows.append({'id':id,'method':name,'officialDER':official,'javascriptDER':js,'differencePP':official-js,'components':detail})
  assert abs(official-js)<=.011,(id,name,official,js)
(out/'metric-crosscheck.json').write_text(json.dumps({'passed':True,'package':'pyannote.metrics','collar':0,'skipOverlap':False,'rows':rows},indent=2));print('Official pyannote.metrics crosscheck passed',len(rows),'hypotheses')
