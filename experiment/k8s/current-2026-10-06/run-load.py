#!/usr/bin/env python3
import json,subprocess,sys,time,threading
from pathlib import Path
phase=sys.argv[1]; expected=int(sys.argv[2])
if expected<2:raise SystemExit('All multi-Pod tests require at least two gateways')
K=['kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
root=Path('experiment/k8s/current-2026-10-06/results')
stop=threading.Event(); samples=[]
def capture():
    for kind in ['deployments','pods']:
        value=json.loads(subprocess.check_output(K+['get',kind,'-o','json'],text=True))
        if kind=='deployments':
            deployments=[{'name':d['metadata']['name'],'replicas':d['spec'].get('replicas'),'ready':d['status'].get('readyReplicas',0),'updated':d['status'].get('updatedReplicas',0),'available':d['status'].get('availableReplicas',0)} for d in value['items'] if d['metadata']['name'] in ['gateway','audio-worker','test-ingress']]
        else:
            pods=[{'pod':p['metadata']['name'],'app':p['metadata'].get('labels',{}).get('app'),'ready':all(c.get('ready',False) for c in p['status'].get('containerStatuses',[])),'restarts':sum(c.get('restartCount',0) for c in p['status'].get('containerStatuses',[]))} for p in value['items'] if p['metadata'].get('labels',{}).get('app') in ['gateway','audio-worker','redis','sentinel','test-ingress']]
    return {'at':time.time(),'deployments':deployments,'pods':pods}
initial=capture()
for deployment in initial['deployments']:
    if deployment['ready']<2:raise SystemExit('Not enough ready Pods: '+deployment['name'])
if next(d['replicas'] for d in initial['deployments'] if d['name']=='gateway')!=expected:raise SystemExit('Unexpected replica count')
samples.append(initial)
def watch():
    while not stop.wait(2):
        try:samples.append(capture())
        except subprocess.CalledProcessError as error:samples.append({'at':time.time(),'error':'kubectl observation failed','exit':error.returncode})
thread=threading.Thread(target=watch);thread.start()
try:
    with (root/(phase+'-load.json')).open('w') as output:
        subprocess.run(K+['exec','load-client','--','node','/tmp/load-test.cjs','load',phase,'100','90','1500'],stdout=output,check=True)
finally:
    stop.set();thread.join();samples.append(capture());(root/(phase+'-pods.json')).write_text(json.dumps(samples,indent=2)+'\n')
