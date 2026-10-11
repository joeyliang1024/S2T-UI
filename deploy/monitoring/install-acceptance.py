#!/usr/bin/env python3
"""Install isolated synthetic acceptance traffic and update only monitoring config."""
import json, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
NS = 's2t-stress-20261005'
K = ['kubectl', '--context', 'colima-s2t-stress', '-n', NS]
def run(*args, data=None):
    return subprocess.check_output(K + list(args), input=data, text=True)
image = json.loads(run('get','deployment','gateway','-o','json'))['spec']['template']['spec']['containers'][0]['image']
files = {'index.cjs': 'server/index.cjs', 'usage-metrics.cjs': 'server/usage-metrics.cjs', 'auth.cjs': 'server/auth/index.cjs', 'acceptance.cjs': 'deploy/monitoring/acceptance.cjs'}
items = [{'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'monitoring-acceptance-code','namespace':NS},'data':{key:(ROOT / file).read_text() for key,file in files.items()}}]
mounts = [{'name':'code','mountPath':path,'subPath':key,'readOnly':True} for key,path in [('index.cjs','/app/server/index.cjs'),('usage-metrics.cjs','/app/server/usage-metrics.cjs'),('auth.cjs','/app/server/auth/index.cjs'),('acceptance.cjs','/app/monitoring-acceptance.cjs')]]
items.append({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'monitoring-acceptance','namespace':NS,'labels':{'s2t-purpose':'synthetic-acceptance'}},'spec':{'replicas':1,'selector':{'matchLabels':{'app':'monitoring-acceptance'}},'template':{'metadata':{'labels':{'app':'monitoring-acceptance','s2t-purpose':'synthetic-acceptance'}},'spec':{'automountServiceAccountToken':False,'containers':[{'name':'acceptance','image':image,'imagePullPolicy':'IfNotPresent','command':['node','/app/monitoring-acceptance.cjs'],'ports':[{'containerPort':8787}],'volumeMounts':mounts,'resources':{'requests':{'cpu':'20m','memory':'96Mi'},'limits':{'cpu':'500m','memory':'256Mi'}},'readinessProbe':{'httpGet':{'path':'/healthz','port':8787},'initialDelaySeconds':5,'periodSeconds':5}}],'volumes':[{'name':'code','configMap':{'name':'monitoring-acceptance-code'}}]}}}})
items.append({'apiVersion':'v1','kind':'Service','metadata':{'name':'monitoring-acceptance','namespace':NS},'spec':{'selector':{'app':'monitoring-acceptance'},'ports':[{'port':8787,'targetPort':8787}]}})
print(run('apply','-f','-',data=json.dumps({'apiVersion':'v1','kind':'List','items':items})))
config = json.loads(run('get','configmap','prometheus-config','-o','json'))['data']['prometheus.yml']
if 'job_name: gateway-acceptance' not in config:
    config += '  - job_name: gateway-acceptance\n    static_configs: [{targets: ["monitoring-acceptance:8787"], labels: {service: acceptance, pod: synthetic-acceptance}}]\n'
print(run('patch','configmap','prometheus-config','--type','merge','-p',json.dumps({'data':{'prometheus.yml':config}})))
dashboard = json.loads((ROOT / 'deploy/monitoring/dashboard.json').read_text())
print(run('patch','configmap','s2t-dashboard','--type','merge','-p',json.dumps({'data':{'dashboard.json':json.dumps(dashboard,ensure_ascii=False),'oncall.json':(ROOT / 'deploy/monitoring/oncall.json').read_text()}})))
# ConfigMap subPath code requires an explicit restart when rerunning the installer.
print(run('rollout','restart','deployment/monitoring-acceptance'))
print(run('rollout','restart','deployment/prometheus'))
print(run('rollout','restart','deployment/grafana'))
print('Updated isolated acceptance data and monitoring. Existing gateway/audio-worker deployments are unchanged.')
