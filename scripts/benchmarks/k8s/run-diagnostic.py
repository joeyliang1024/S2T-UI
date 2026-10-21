#!/usr/bin/env python3
import json, subprocess
from pathlib import Path
K=['/opt/homebrew/bin/kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
def get(kind,name):return json.loads(subprocess.check_output(K+['get',kind,name,'-o','json']))
cm=get('configmap','performance-code');cm['data']['route-burst.cjs']=Path(__file__).with_name('route-burst.cjs').read_text()
subprocess.run(K+['apply','-f','-'],input=json.dumps(cm),text=True,check=True,stdout=subprocess.DEVNULL)
pods=json.loads(subprocess.check_output(K+['get','pods','-l','app=gateway','-o','json']))['items']
ips=[p['status']['podIP'] for p in pods if not p['metadata'].get('deletionTimestamp') and all(c['ready'] for c in p['status'].get('containerStatuses',[]))]
if len(ips)!=2:raise RuntimeError('Two ready Gateway pods required before diagnostic')
template=get('deployment','performance-load-smoke-0')['spec']['template']
template['metadata']={'labels':{'app':'performance-route-diagnostic'}}
template['spec']['restartPolicy']='Never';c=template['spec']['containers'][0];c['command']=['node','/perf/route-burst.cjs'];c['env'].append({'name':'PERF_POD_IPS','value':','.join(ips)})
job={'apiVersion':'batch/v1','kind':'Job','metadata':{'generateName':'performance-route-diagnostic-','namespace':'s2t-stress-20261005'},'spec':{'backoffLimit':0,'ttlSecondsAfterFinished':3600,'template':template}}
r=json.loads(subprocess.check_output(K+['create','-f','-','-o','json'],input=json.dumps(job),text=True));print(r['metadata']['name'])
