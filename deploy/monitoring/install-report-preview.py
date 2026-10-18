#!/usr/bin/env python3
"""Install a bounded metrics-only preview; keep real dashboards and user data separate."""
import json
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
NS = 's2t-stress-20261005'
K = ['kubectl', '--context', 'colima-s2t-stress', '-n', NS]
def run(*args, data=None):
    return subprocess.check_output(K + list(args), input=data, text=True)
image = json.loads(run('get', 'deployment', 'gateway', '-o', 'json'))['spec']['template']['spec']['containers'][0]['image']
files = {'report-preview.cjs': ROOT/'deploy/monitoring/report-preview.cjs', 'metrics.cjs': ROOT/'server/metrics.cjs', 'usage-metrics.cjs': ROOT/'server/usage-metrics.cjs'}
items = [{'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'report-preview-code', 'namespace': NS}, 'data': {key: path.read_text() for key, path in files.items()}}]
items.append({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'report-preview','namespace':NS},'spec':{'replicas':1,'selector':{'matchLabels':{'app':'report-preview'}},'template':{'metadata':{'labels':{'app':'report-preview','s2t-purpose':'report-preview'}},'spec':{'automountServiceAccountToken':False,'containers':[{'name':'preview','image':image,'command':['node','/preview/report-preview.cjs'],'volumeMounts':[{'name':'code','mountPath':'/preview','readOnly':True}],'ports':[{'containerPort':8787}],'resources':{'requests':{'cpu':'10m','memory':'32Mi'},'limits':{'cpu':'200m','memory':'96Mi'}},'readinessProbe':{'httpGet':{'path':'/healthz','port':8787},'periodSeconds':3}}],'volumes':[{'name':'code','configMap':{'name':'report-preview-code'}}]}}}})
items.append({'apiVersion':'v1','kind':'Service','metadata':{'name':'report-preview','namespace':NS},'spec':{'selector':{'app':'report-preview'},'ports':[{'port':8787,'targetPort':8787}]}})
print(run('apply','-f','-',data=json.dumps({'apiVersion':'v1','kind':'List','items':items})))
config = json.loads(run('get','configmap','prometheus-config','-o','json'))['data']['prometheus.yml']
if 'job_name: gateway-report-preview' not in config:
    config += '  - job_name: gateway-report-preview\n    scrape_interval: 5s\n    static_configs: [{targets: ["report-preview:8787"], labels: {service: report-preview}}]\n'
print(run('patch','configmap','prometheus-config','--type','merge','-p',json.dumps({'data':{'prometheus.yml':config}})))
preview = {}
for source, uid in [('dashboard.json','s2t-report-preview'), ('oncall.json','s2t-oncall-preview')]:
    dashboard=json.loads((ROOT/'deploy/monitoring'/source).read_text())
    dashboard.update({'uid':uid,'title':'【測試資料預覽】'+dashboard['title'],'time':{'from':'now-7d','to':'now'},'refresh':'30s','description':'獨立合成資料，非實際服務效能；3 部門、12 使用者，最多產生 15 分鐘。所有圖表依上方所選時間區間顯示，沒有回填歷史資料。'})
    for variable in dashboard['templating']['list']:
        if variable['name']=='caption_gateway':
            variable.update({'query':'獨立測試資料 : gateway-report-preview','current':{'text':'獨立測試資料','value':'gateway-report-preview'},'options':[{'text':'獨立測試資料','value':'gateway-report-preview','selected':True}]})
    dashboard['links']=[{'title':'返回正式詳細總覽','type':'link','url':'/d/s2t-overview','targetBlank':True}]
    preview[uid+'.json']=json.dumps(dashboard,ensure_ascii=False)
print(run('apply','-f','-',data=json.dumps({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'report-preview-dashboards','namespace':NS},'data':preview})))
# Add a distinct mounted ConfigMap; never replace the real dashboard definitions.
patch={'spec':{'template':{'spec':{'volumes':[{'name':'report-preview-dashboards','configMap':{'name':'report-preview-dashboards'}}],'containers':[{'name':'grafana','volumeMounts':[{'name':'report-preview-dashboards','mountPath':'/var/lib/grafana/dashboards/preview','readOnly':True}]}]}}}}
print(run('patch','deployment','grafana','--type','strategic','-p',json.dumps(patch)))
print(run('rollout','restart','deployment/report-preview'))
print(run('rollout','restart','deployment/prometheus'))
print('Preview isolated under gateway-report-preview; traffic stops after 15 minutes.')
