from pathlib import Path
import json,time,numpy as np,sys
out=Path(__file__).resolve().parents[2]/'outputs/diarization'
suffix='-nemotron' if '--nemotron' in sys.argv else ''
for id in [x for x in sys.argv[1:] if x!='--nemotron'] or ['ldnro']:
 d=json.loads((out/f'{id}{suffix}-segment-embeddings.json').read_text());valid=[i for i,x in enumerate(d['rows']) if x['embedding']]
 X=np.array([d['rows'][i]['embedding'] for i in valid]);X/=np.maximum(np.linalg.norm(X,axis=1,keepdims=True),1e-12);C=X@X.T
 results=[]
 for fraction in [.1,.2]:
  start=time.monotonic();n=len(X);top=max(3,int(np.ceil(n*fraction)));A=np.zeros_like(C)
  for i in range(n):
   indices=np.argsort(C[i])[-top:];A[i,indices]=np.exp((C[i,indices]-1)/.1)
  A=(A+A.T)/2;np.fill_diagonal(A,0);degree=np.maximum(A.sum(axis=1),1e-12);L=np.eye(n)-A/np.sqrt(degree[:,None]*degree[None,:]);values,vectors=np.linalg.eigh(L)
  limit=min(20,n-1);gaps=np.diff(values[:limit+1]);k=int(np.argmax(gaps)+1)
  Z=vectors[:,:k];Z/=np.maximum(np.linalg.norm(Z,axis=1,keepdims=True),1e-12)
  rng=np.random.default_rng(42);centers=[Z[int(rng.integers(n))]]
  while len(centers)<k:
   dist=np.min(((Z[:,None,:]-np.array(centers)[None,:,:])**2).sum(axis=2),axis=1);centers.append(Z[int(np.argmax(dist))])
  centers=np.array(centers);labels=np.zeros(n,dtype=int)
  for step in range(100):
   updated=np.argmin(((Z[:,None,:]-centers[None,:,:])**2).sum(axis=2),axis=1)
   if step and np.array_equal(updated,labels):break
   labels=updated
   for j in range(k):
    if np.any(labels==j):centers[j]=Z[labels==j].mean(axis=0)
  turns=[]
  for i,row in enumerate(d['rows']):
   if i in valid:label=int(labels[valid.index(i)])
   else:
    # Short segments carry no usable vector: nearest-in-time provisional tag.
    midpoint=(row['start']+row['end'])/2
    nearest=min(range(n),key=lambda j:abs((d['rows'][valid[j]]['start']+d['rows'][valid[j]]['end'])/2-midpoint));label=int(labels[nearest])
   turns.append({'start':row['start'],'end':row['end'],'speaker':f'SPECTRAL_{label:02d}'})
  results.append({'method':f'{"nemotron-segment-" if suffix else ""}spectral-knn-{fraction}','estimatedCount':k,'sampledSegments':n,'fraction':fraction,'eigenvalues':values[:limit+1].tolist(),'eigenGaps':gaps.tolist(),'turns':turns,'elapsedMs':(time.monotonic()-start)*1000,'extraEmbeddingMs':d['elapsedMs'],'shortSegmentsWithoutEmbedding':len(d['rows'])-n})
 (out/f'{id}{suffix}-spectral.json').write_text(json.dumps({'id':id,'duration':d['duration'],'results':results}));print(id,[(x['method'],x['estimatedCount']) for x in results],flush=True)
