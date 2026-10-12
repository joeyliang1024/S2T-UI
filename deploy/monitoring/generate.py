#!/usr/bin/env python3
"""Generate the isolated K8s monitoring stack and its single provisioned dashboard."""
import json, ipaddress
from connection import gateway_metrics_url
from urllib.parse import urlparse
from pathlib import Path
N='s2t-stress-20261005'; items=[]
def add(kind,name,spec=None,**rest):
    obj={'apiVersion':{'Deployment':'apps/v1','DaemonSet':'apps/v1','Role':'rbac.authorization.k8s.io/v1','RoleBinding':'rbac.authorization.k8s.io/v1','ClusterRole':'rbac.authorization.k8s.io/v1','ClusterRoleBinding':'rbac.authorization.k8s.io/v1','NetworkPolicy':'networking.k8s.io/v1'}.get(kind,'v1'),'kind':kind,'metadata':{'name':name,**({} if kind.startswith('Cluster') else {'namespace':N})},**rest}
    if spec is not None:obj['spec']=spec
    items.append(obj)
def svc(name,port): add('Service',name,{'selector':{'app':name},'ports':[{'port':port,'targetPort':port}]})
def deploy(name,image,port,args=[],env=[],volumes=[],mounts=[],cpu='20m',mem='64Mi',serviceAccount=None):
    pod={'containers':[{'name':name,'image':image,'args':args,'env':env,'ports':[{'containerPort':port}],'resources':{'requests':{'cpu':cpu,'memory':mem},'limits':{'memory':'512Mi' if name=='prometheus' else '384Mi' if name=='grafana' else '128Mi'}},'volumeMounts':mounts}], 'volumes':volumes}
    if serviceAccount:pod['serviceAccountName']=serviceAccount
    add('Deployment',name,{'replicas':1,'strategy':{'type':'Recreate'},'selector':{'matchLabels':{'app':name}},'template':{'metadata':{'labels':{'app':name}},'spec':pod}});svc(name,port)
def cm(name,data):add('ConfigMap',name,data=data)
def secretEnv(name,key):return {'name':name,'valueFrom':{'secretKeyRef':{'name':'monitoring-credentials','key':key}}}
add('ServiceAccount','prometheus');add('ServiceAccount','kube-state-metrics')
add('Role','prometheus',rules=[{'apiGroups':[''],'resources':['pods','services','endpoints'],'verbs':['get','list','watch']}])
add('RoleBinding','prometheus',subjects=[{'kind':'ServiceAccount','name':'prometheus','namespace':N}],roleRef={'apiGroup':'rbac.authorization.k8s.io','kind':'Role','name':'prometheus'})
add('ClusterRole','s2t-stress-prometheus',rules=[{'apiGroups':[''],'resources':['nodes','nodes/proxy','nodes/metrics'],'verbs':['get','list','watch']}])
add('ClusterRoleBinding','s2t-stress-prometheus',subjects=[{'kind':'ServiceAccount','name':'prometheus','namespace':N}],roleRef={'apiGroup':'rbac.authorization.k8s.io','kind':'ClusterRole','name':'s2t-stress-prometheus'})
add('Role','kube-state-metrics',rules=[{'apiGroups':[''],'resources':['pods','persistentvolumeclaims'],'verbs':['list','watch']},{'apiGroups':['apps'],'resources':['deployments','replicasets','statefulsets','daemonsets'],'verbs':['list','watch']},{'apiGroups':['batch'],'resources':['jobs'],'verbs':['list','watch']}])
add('RoleBinding','kube-state-metrics',subjects=[{'kind':'ServiceAccount','name':'kube-state-metrics','namespace':N}],roleRef={'apiGroup':'rbac.authorization.k8s.io','kind':'Role','name':'kube-state-metrics'})
# Only Prometheus gets API-server egress. Existing model egress restriction remains.
add('NetworkPolicy','monitoring-api-access',{'podSelector':{'matchLabels':{'app':'prometheus'}},'policyTypes':['Egress'],'egress':[{'to':[{'ipBlock':{'cidr':'10.43.0.1/32'}},{'ipBlock':{'cidr':'192.168.5.3/32'}}],'ports':[{'protocol':'TCP','port':443},{'protocol':'TCP','port':59119}]}]})
add('NetworkPolicy','monitoring-state-access',{'podSelector':{'matchLabels':{'app':'kube-state-metrics'}},'policyTypes':['Egress'],'egress':[{'to':[{'ipBlock':{'cidr':'10.43.0.1/32'}},{'ipBlock':{'cidr':'192.168.5.3/32'}}],'ports':[{'protocol':'TCP','port':443},{'protocol':'TCP','port':59119}]}]})
cm('cgroup-exporter', {'collector.cjs': Path(__file__).with_name('cgroup-exporter.cjs').read_text()})
add('DaemonSet','cgroup-exporter',{'selector':{'matchLabels':{'app':'cgroup-exporter'}},'template':{'metadata':{'labels':{'app':'cgroup-exporter'}},'spec':{'automountServiceAccountToken':False,'containers':[{'name':'collector','image':'node:22-bookworm-slim','command':['node','/collector/collector.cjs'],'ports':[{'containerPort':9108}],'resources':{'requests':{'cpu':'10m','memory':'32Mi'},'limits':{'memory':'96Mi'}},'securityContext':{'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},'volumeMounts':[{'name':'code','mountPath':'/collector','readOnly':True},{'name':'cgroups','mountPath':'/host-cgroup','readOnly':True}]}],'volumes':[{'name':'code','configMap':{'name':'cgroup-exporter'}},{'name':'cgroups','hostPath':{'path':'/sys/fs/cgroup','type':'Directory'}}]}}})
svc('cgroup-exporter',9108)
config='''global:
  scrape_interval: 5s
  evaluation_interval: 5s
scrape_configs:
  - job_name: s2t
    kubernetes_sd_configs:
      - role: pod
        namespaces: {names: [s2t-stress-20261005]}
    relabel_configs:
      - {source_labels: [__meta_kubernetes_pod_label_app], regex: 'gateway|audio-worker', action: keep}
      - {source_labels: [__meta_kubernetes_pod_phase], regex: Running, action: keep}
      - {source_labels: [__meta_kubernetes_pod_container_port_number], regex: '8787', action: keep}
      - {source_labels: [__meta_kubernetes_pod_name], target_label: pod}
      - {source_labels: [__meta_kubernetes_pod_label_app], target_label: service}
  - job_name: prometheus
    static_configs: [{targets: ['localhost:9090']}]
  - job_name: cgroups
    static_configs: [{targets: ['cgroup-exporter:9108']}]
  - job_name: grafana
    static_configs: [{targets: ['grafana:3000']}]
  - job_name: kube-state
    static_configs: [{targets: ['kube-state-metrics:8080']}]
  - job_name: postgres
    static_configs: [{targets: ['postgres-exporter:9187']}]
  - job_name: minio
    metrics_path: /minio/v2/metrics/cluster
    static_configs: [{targets: ['minio:9000']}]
  - job_name: milvus
    static_configs: [{targets: ['milvus:9091']}]
  - job_name: etcd
    static_configs: [{targets: ['etcd:2379']}]
  - job_name: mock-models
    static_configs: [{targets: ['mock-models:9090']}]
  - job_name: redis
    metrics_path: /scrape
    static_configs: [{targets: ['redis-0.redis:6379', 'redis-1.redis:6379', 'redis-2.redis:6379']}]
    relabel_configs:
      - {source_labels: [__address__], target_label: __param_target}
      - {source_labels: [__param_target], target_label: instance}
      - {target_label: __address__, replacement: 'redis-exporter:9121'}
  - job_name: sentinel
    metrics_path: /scrape
    static_configs: [{targets: ['sentinel-0.sentinel:26379', 'sentinel-1.sentinel:26379', 'sentinel-2.sentinel:26379']}]
    relabel_configs:
      - {source_labels: [__address__], target_label: __param_target}
      - {source_labels: [__param_target], target_label: instance}
      - {target_label: __address__, replacement: 'sentinel-exporter:9121'}
  - job_name: kubelet-cadvisor
    scheme: https
    authorization: {credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token}
    tls_config: {ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt}
    kubernetes_sd_configs: [{role: node}]
    relabel_configs:
      - {target_label: __address__, replacement: 'kubernetes.default.svc:443'}
      - {source_labels: [__meta_kubernetes_node_name], target_label: node}
      - {source_labels: [__meta_kubernetes_node_name], target_label: __metrics_path__, replacement: '/api/v1/nodes/$1/proxy/metrics/cadvisor'}
    metric_relabel_configs:
      - {source_labels: [namespace], regex: 's2t-stress-20261005|', action: keep}
'''
config += '''  - job_name: kubelet
    scheme: https
    authorization: {credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token}
    tls_config: {ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt}
    kubernetes_sd_configs: [{role: node}]
    relabel_configs:
      - {target_label: __address__, replacement: 'kubernetes.default.svc:443'}
      - {source_labels: [__meta_kubernetes_node_name], target_label: node}
      - {source_labels: [__meta_kubernetes_node_name], target_label: __metrics_path__, replacement: '/api/v1/nodes/$1/proxy/metrics'}
'''
# Optional real Web gateway; default isolation still collects the test cluster only.
external_gateway = gateway_metrics_url()
if any(char.isspace() for char in external_gateway):
    raise ValueError('S2T_GATEWAY_METRICS_URL cannot contain whitespace')
if external_gateway:
    parsed = urlparse(external_gateway)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('S2T_GATEWAY_METRICS_URL must be an HTTP(S) metrics URL without credentials, query or fragment')
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    address = ('[' + parsed.hostname + ']' if ':' in parsed.hostname else parsed.hostname) + ':' + str(port)
    config += '  - job_name: gateway-web\n    scheme: ' + parsed.scheme + '\n    metrics_path: ' + json.dumps(parsed.path or '/metrics') + '\n    static_configs: [{targets: [' + json.dumps(address) + '], labels: {service: gateway, pod: web-gateway}}]\n'
    # Narrow exception: Prometheus may scrape this IP and port only.
    # DNS targets require an operator-managed egress policy.
    try:
        host_ip = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        host_ip = None
    if host_ip is not None:
        add('NetworkPolicy', 'monitoring-web-gateway', {'podSelector': {'matchLabels': {'app': 'prometheus'}}, 'policyTypes': ['Egress'], 'egress': [{'to': [{'ipBlock': {'cidr': str(host_ip) + ('/32' if host_ip.version == 4 else '/128')}}], 'ports': [{'protocol': 'TCP', 'port': port}]}]})
cm('prometheus-config',{'prometheus.yml':config})
for name in ['prometheus','grafana']:add('PersistentVolumeClaim',name+'-data',{'accessModes':['ReadWriteOnce'],'resources':{'requests':{'storage':'2Gi'}}})
deploy('prometheus','prom/prometheus:v3.5.0',9090,args=['--config.file=/etc/prometheus/prometheus.yml','--storage.tsdb.path=/prometheus','--storage.tsdb.retention.time=3d','--storage.tsdb.retention.size=1GB'],volumes=[{'name':'config','configMap':{'name':'prometheus-config'}},{'name':'data','persistentVolumeClaim':{'claimName':'prometheus-data'}}],mounts=[{'name':'config','mountPath':'/etc/prometheus'},{'name':'data','mountPath':'/prometheus'}],cpu='100m',mem='192Mi',serviceAccount='prometheus')
items[-2]['spec']['template']['spec']['securityContext']={'fsGroup':65534}
deploy('kube-state-metrics','registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.16.0',8080,args=['--namespaces='+N,'--resources=pods,persistentvolumeclaims,deployments,replicasets,statefulsets,daemonsets,jobs'],serviceAccount='kube-state-metrics')
deploy('postgres-exporter','quay.io/prometheuscommunity/postgres-exporter:v0.17.1',9187,env=[secretEnv('DATA_SOURCE_NAME','postgres-dsn')])
for name,key in [('redis-exporter','redis-password'),('sentinel-exporter','sentinel-password')]:
    deploy(name,'oliver006/redis_exporter:v1.88.0',9121,args=['--redis.addr='],env=[secretEnv('REDIS_PASSWORD',key)],cpu='10m')
cm('monitoring-connection', {'PROMETHEUS_URL': 'http://prometheus:9090'})
# The acceptance installer patches the live config; keep regeneration consistent.
for obj in items:
    if obj['kind'] == 'ConfigMap' and obj['metadata']['name'] == 'prometheus-config':
        obj['data']['prometheus.yml'] += '  - job_name: gateway-acceptance\n    static_configs: [{targets: ["monitoring-acceptance:8787"], labels: {service: acceptance, pod: synthetic-acceptance}}]\n'
cm('grafana-provisioning',{'datasources.yaml':'apiVersion: 1\ndatasources:\n  - name: Prometheus\n    uid: s2t-prometheus\n    type: prometheus\n    access: proxy\n    url: ${PROMETHEUS_URL}\n    isDefault: true\n    jsonData: {timeInterval: 5s}\n','dashboards.yaml':'apiVersion: 1\nproviders:\n  - name: S2T\n    type: file\n    updateIntervalSeconds: 10\n    options: {path: /var/lib/grafana/dashboards}\n'})
# The single dashboard deliberately separates measured UI latency from server-only load.
# Datasource uid and the gateway job travel as template variables, so nothing here is
# bound to one deployment's datasource uid or job name.
DS = {'type': 'prometheus', 'uid': '${datasource}'}
PHASE_LABELS = {'t1': 't1 音訊擷取與上傳', 't2': 't2 VAD 偵測與分段', 't3': 't3 ASR 模型推論', 't4': 't4 文字後處理', 't5': 't5 回傳轉錄與呈現', 't6': 't6 翻譯模型', 't7': 't7 翻譯回傳與呈現'}
STAGE_LABELS = {'t1_queue': '瀏覽器請求佇列', 't1_encode': 'WAV 編碼與前置', 't1_upload': '上傳（伺服器收音訊）', 't2_vad': 'VAD 語音偵測', 't2_segment': '句段累積', 't2_gate': 'Silero 二次確認', 't3_queue': '伺服器容量排隊', 't3_preprocess': '音訊前處理', 't3_model': 'ASR 模型推論', 't3_gateway': '伺服器驗證／快取／寫出', 't4_postprocess': '文字清理（標點／不雅字）', 't5_network': '回傳網路與重試', 't5_paint': 'UI 呈現', 't6_wait': '翻譯排隊等待', 't6_queue': '翻譯容量排隊', 't6_model': '翻譯模型推論', 't6_gateway': '翻譯伺服器固定處理', 't7_network': '譯文回傳網路', 't7_paint': '譯文 UI 呈現'}
panels=[]; y=0; ident=1
def panel(title,expr,unit='short',legend='',width=12,height=7,description='',typ='timeseries',x=0):
    global ident
    panels.append({'id':ident,'title':title,'type':typ,'gridPos':{'x':x,'y':y,'w':width,'h':height},'datasource':DS,'targets':[{'refId':'A','expr':expr,'legendFormat':legend}], 'description':description,'fieldConfig':{'defaults':{'unit':unit,'min':0},'overrides':[]},'options':{'legend':{'displayMode':'table','placement':'bottom','calcs':['lastNotNull'],'height':170},'tooltip':{'mode':'multi'},'reduceOptions':{'calcs':['lastNotNull'],'fields':'','values':False}}});ident+=1
def instant():
    panels[-1]['targets'][0].update({'instant':True,'range':False})
    panels[-1]['options']['reduceOptions']['calcs']=['last']
def labels(mapping):
    for name,label in mapping.items():panels[-1]['fieldConfig']['overrides'].append({'matcher':{'id':'byName','options':name},'properties':[{'id':'displayName','value':label}]})
def bargauge():
    panels[-1]['options']={'orientation':'horizontal','displayMode':'gradient','showUnfilled':True,'reduceOptions':{'calcs':['last'],'fields':'','values':False}}
def row(title):
    global ident,y
    panels.append({'id':ident,'title':title,'type':'row','collapsed':False,'gridPos':{'x':0,'y':y,'w':24,'h':1}});ident+=1;y+=1
def pair(a,b):
    global y
    panel(*a,x=0);panel(*b,x=12);y+=7
row('00 · 總覽 KPI（最近 5 分鐘）· 來源：$caption_gateway')
kpi_description = '端到端 = 語音起點到文字首次在 Web UI 呈現；固定最近 5 分鐘，沒有新樣本時顯示無資料而不是保留舊值。'
for x,q in enumerate([.5,.95,.99]):
    panel(f'ASR 語音→原文 P{int(q*100)}', f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_asr"}}[5m])) by (le))', 's', width=6, height=4, x=x*6, typ='stat', description=kpi_description)
    instant()
    if q == .95:
        panels[-1]['fieldConfig']['defaults'].update({'color':{'mode':'thresholds'},'thresholds':{'mode':'absolute','steps':[{'color':'green','value':None},{'color':'orange','value':2},{'color':'red','value':5}]}})
panel('目前瓶頸階段（5 分鐘平均最慢）', 'topk(1, sum by (phase) (rate(s2t_caption_stage_duration_seconds_sum{phase=~"t[1-5]"}[5m])) / sum by (phase) (rate(s2t_caption_stage_duration_seconds_count{phase=~"t[1-5]"}[5m])))', 's', '{{phase}}', width=6, height=4, x=18, typ='stat', description='最近 5 分鐘 t1~t5 中平均耗時最長的階段名稱（rate(_sum)/rate(_count) 取最大）。先看這裡，再對照下一列的階段長條圖確認量級。')
instant(); labels(PHASE_LABELS)
# Show the slowest phase's name (t3 ASR 模型推論 …), not its numeric value.
panels[-1]['options']['textMode'] = 'name'
panels[-1]['fieldConfig']['defaults'].update({'color':{'mode':'fixed','fixedColor':'orange'}})
y+=4
panel('翻譯 語音→譯文 P95', f'histogram_quantile(0.95, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_translation"}}[5m])) by (le))', 's', width=6, height=4, x=0, typ='stat', description='語音起點到譯文在 UI 呈現（含前段 ASR 等待）；翻譯未啟用時無資料。')
instant()
panel('已呈現 ASR 樣本（5 分鐘）', 'sum(increase(s2t_caption_stage_duration_seconds_count{stage="e2e_asr"}[5m]))', width=6, height=4, x=6, typ='stat', description='無有效樣本時，上方延遲分位數不能用來判斷服務正常。')
instant(); panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'text'}
panel('API 錯誤率（5 分鐘）', 'sum(rate(s2t_gateway_request_errors_total[5m])) / sum(rate(s2t_gateway_request_duration_seconds_count[5m]))', 'percentunit', width=6, height=4, x=12, typ='stat', description='4xx 與 5xx 合計佔比；無請求時不填零。')
instant()
panel('監控入口狀態', 'min(up{job="$caption_gateway"})', width=6, height=4, x=18, typ='stat', description='Prometheus 是否能抓取所選來源；可抓取不等同模型或下游服务正常。')
instant(); panels[-1]['fieldConfig']['defaults']['mappings']=[{'type':'value','options':{'0':{'text':'抓取失敗','color':'red'},'1':{'text':'可抓取','color':'green'}}}]
y+=4

row('01 · ASR 瓶頸分析 — 語音起點 → 原文呈現（t1~t5）· 來源：$caption_gateway')
panel('ASR 階段平均耗時（所選範圍）· 最長者即瓶頸',
      'sort_desc(sum by (phase) (increase(s2t_caption_stage_duration_seconds_sum{phase=~"t[1-5]"}[$__range])) / sum by (phase) (increase(s2t_caption_stage_duration_seconds_count{phase=~"t[1-5]"}[$__range])))',
      's', '{{phase}}', width=8, height=8, x=0, typ='bargauge',
      description='t1 音訊擷取上傳／t2 VAD 與分段／t3 ASR 模型推論／t4 文字後處理／t5 回傳與呈現 的平均耗時，由長到短排列：最長的一根就是瓶頸。t3 最大＝模型推論吃緊；t1 大＝上傳或編碼；t5 大＝回傳網路與重試；t2 大＝分段累積或 VAD 確認慢。')
bargauge(); labels(PHASE_LABELS)
panel('ASR 階段耗時占比（所選範圍）',
      'sum by (phase) (increase(s2t_caption_stage_duration_seconds_sum{phase=~"t[1-5]"}[$__range])) / scalar(sum(increase(s2t_caption_stage_duration_seconds_sum{phase=~"t[1-5]"}[$__range])))',
      'percentunit', '{{phase}}', width=8, height=8, x=8, typ='piechart', description='同一批樣本的耗時占比（不是分位數的拆分）；配合左側長條圖判讀瓶頸佔了多少比例。')
instant()
panels[-1]['options']={'pieType':'donut','displayLabels':['percent'],'reduceOptions':{'calcs':['last'],'fields':'','values':False},'legend':{'displayMode':'table','placement':'right','values':['value'],'showLegend':True}}
labels(PHASE_LABELS)
panel('ASR 明細平均耗時（每個細項，所選範圍）',
      'sort_desc(sum by (stage) (increase(s2t_caption_stage_duration_seconds_sum{stage=~"t[1-5]_.*"}[$__range])) / sum by (stage) (increase(s2t_caption_stage_duration_seconds_count{stage=~"t[1-5]_.*"}[$__range])))',
      's', '{{stage}}', width=8, height=8, x=16, typ='bargauge', description='確認最長階段後，用這根定位到原子量測：佇列、編碼、上傳、VAD、排隊、模型推論、後處理、網路、呈現。0 秒的可選步驟（如未啟用的前處理）不會輸出樣本。')
bargauge(); labels(STAGE_LABELS)
y+=8
panel('ASR 端到端延遲趨勢 P50／P95／P99', '', 's', width=16, height=6, x=0, typ='timeseries', description='完整鏈路分位數趨勢（固定 5 分鐘窗口）；先看是否惡化，再回到上排確認當下瓶頸。')
panels[-1]['targets']=[{'refId':str(i),'expr':f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_asr"}}[5m])) by (le))','legendFormat':f'P{int(q*100)}','range':True,'instant':False} for i,q in enumerate([.5,.95,.99])]
panels[-1]['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
panel('ASR 各階段平均耗時趨勢（堆疊）',
      'sum by (phase) (rate(s2t_caption_stage_duration_seconds_sum{phase=~"t[1-5]"}[1m])) / sum by (phase) (rate(s2t_caption_stage_duration_seconds_count{phase=~"t[1-5]"}[1m]))',
      's', '{{phase}}', width=8, height=6, x=16, typ='timeseries', description='每分鐘各階段的平均耗時，堆疊總高近似每段請求的平均時間；哪一層突然變厚，就是新出現的瓶頸。')
panels[-1]['fieldConfig']['defaults'].update({'color':{'mode':'palette-classic'},'custom':{'stacking':{'mode':'normal','group':'A'}}})
labels(PHASE_LABELS)
y+=6
panel('有效 ASR 端到端樣本（所選範圍）', 'sum(increase(s2t_caption_stage_duration_seconds_count{stage="e2e_asr"}[$__range]))', width=8, height=5, x=0, typ='stat', description='沒有樣本時，上面的分位數與瓶頸判讀都不可信。')
instant(); panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'text'}
panel('ASR 事件（語音偵測／無文字／失敗／缺口）', 'sum(increase(s2t_caption_events_total[5m])) by (event)', 'short', '{{event}}', width=16, height=5, x=8, typ='timeseries', description='asr_failed／asr_empty／audio_gap／silero_veto 等事件；失敗請求不進延遲樣本，必須從這裡觀察，否則分位數會過於樂觀。')
panels[-1]['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
y+=5

row('02 · 翻譯管線 — 原文 → 譯文呈現（t6~t7）· 來源：$caption_gateway')
for x,q in enumerate([.5,.95,.99]):
    panel(f'翻譯 語音→譯文 P{int(q*100)}', f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_translation"}}[5m])) by (le))', 's', width=6, height=4, x=x*6, typ='stat', description='語音起點到譯文在 UI 呈現（含前段 ASR 等待）；固定最近 5 分鐘。')
    instant()
panel('有效翻譯樣本（5 分鐘）', 'sum(increase(s2t_caption_stage_duration_seconds_count{stage="e2e_translation"}[5m]))', width=6, height=4, x=18, typ='stat', description='無樣本時分位數不可信；翻譯未啟用時本列會無資料。')
instant(); panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'text'}
y+=4
panel('翻譯階段平均耗時（所選範圍）',
      'sort_desc(sum by (phase) (increase(s2t_caption_stage_duration_seconds_sum{phase=~"t[67]"}[$__range])) / sum by (phase) (increase(s2t_caption_stage_duration_seconds_count{phase=~"t[67]"}[$__range])))',
      's', '{{phase}}', width=12, height=6, x=0, typ='bargauge', description='t6 排隊等待＋容量排隊＋翻譯模型推論＋伺服器固定處理；t7 回傳網路與譯文呈現。t6_wait 長代表前端排隊，t6_model 長代表模型吃緊。')
bargauge(); labels(PHASE_LABELS)
panel('翻譯端到端延遲趨勢 P50／P95／P99', '', 's', width=12, height=6, x=12, typ='timeseries', description='語音起點到譯文呈現的分位數趨勢（固定 5 分鐘窗口）。')
panels[-1]['targets']=[{'refId':str(i),'expr':f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_translation"}}[5m])) by (le))','legendFormat':f'P{int(q*100)}','range':True,'instant':False} for i,q in enumerate([.5,.95,.99])]
panels[-1]['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
y+=6

row('03 · Gateway / Audio worker / 模擬模型 · 交叉驗證（伺服器端與 t1_upload、t3、t6 對應）')
pair(('Gateway 伺服器階段 p95（與瀏覽器切片同源，勿加總）','histogram_quantile(0.95, sum(rate(s2t_server_stage_duration_seconds_bucket[5m])) by (stage,le))','s','{{stage}}'),('字幕繪出樣本 / 秒','sum(rate(s2t_caption_stage_duration_seconds_count{stage="e2e_asr"}[5m]))'))
pair(('HTTP 路由 p95','histogram_quantile(0.95, sum(rate(s2t_gateway_request_duration_seconds_bucket[5m])) by (route,le))','s','{{route}}'),('HTTP 吞吐 / 秒','sum(rate(s2t_gateway_request_duration_seconds_count[2m])) by (route)','reqps','{{route}}'))
pair(('HTTP 失敗 / 秒','sum(rate(s2t_gateway_request_errors_total[2m])) by (route)','reqps','{{route}}'),('服務進行中請求','s2t_gateway_inflight_requests','short','{{service}} {{pod}}'))
pair(('程序 RSS','s2t_process_resident_memory_bytes','bytes','{{service}} {{pod}}'),('Event loop p99','s2t_event_loop_p99_seconds','s','{{service}} {{pod}}'))
pair(('Diarization 待處理工作 / 最老秒數','max(s2t_diarization_pending_jobs)','short'),('Diarization 最老等待','max(s2t_diarization_oldest_seconds)','s'))
pair(('Mock 模型進行中 / 明確是模擬 API','s2t_mock_active_requests','short','{{operation}}'),('Mock 注入延遲 / 長尾','s2t_mock_configured_delay_seconds','s','{{operation}}'))
row('04 · 所有服務可用性與儲存操作')
pair(('所有 scrape targets（1=成功）','up','short','{{job}} {{instance}}'),('應用儲存操作 p95','histogram_quantile(0.95, sum(rate(s2t_storage_operation_duration_seconds_bucket[5m])) by (service,operation,le))','s','{{service}} {{operation}}'))
pair(('儲存操作失敗 / 秒','sum(rate(s2t_storage_operation_duration_seconds_errors_total[5m])) by (service,operation)','reqps','{{service}} {{operation}}'),('PostgreSQL 連線','sum(pg_stat_database_numbackends) by (datname)','short','{{datname}}'))
pair(('PostgreSQL commits / rollback 每秒','sum(rate(pg_stat_database_xact_commit[5m])) by (datname)','ops','{{datname}} commits'),('PostgreSQL rollback / deadlock 每秒','sum(rate(pg_stat_database_xact_rollback[5m])) by (datname)','ops','{{datname}} rollback'))
pair(('Redis 記憶體','redis_memory_used_bytes{job="redis"}','bytes','{{instance}}'),('Redis clients / blocked','redis_connected_clients{job="redis"}','short','{{instance}}'))
pair(('Redis replication offset','redis_master_repl_offset{job="redis"}','short','{{instance}}'),('Sentinel quorum status / TILT','redis_sentinel_master_ckquorum_status','short','{{instance}}'))
pair(('Sentinel TILT（應為 0）','redis_sentinel_tilt','short','{{instance}}'),('Redis 可用性（含密碼登入）','redis_up','short','{{job}} {{instance}}'))
pair(('MinIO 儲存用量','minio_cluster_usage_total_bytes','bytes'),('MinIO 磁碟可用量','minio_cluster_capacity_usable_free_bytes','bytes'))
pair(('Milvus process RSS','process_resident_memory_bytes{job="milvus"}','bytes'),('Milvus 載入向量數量','milvus_querynode_entity_num','short','{{collection_id}}'))
pair(('etcd leader（1=有 leader）','etcd_server_has_leader','short'),('etcd WAL fsync p95','histogram_quantile(0.95, sum(rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) by (le))','s'))
row('05 · Kubernetes Pods / 容量 / 資源')
pair(('VM node CPU cores','sum(rate(container_cpu_usage_seconds_total{id="/"}[2m]))','short'),('VM node memory','container_memory_working_set_bytes{id="/"}','bytes'))
pair(('Pod CPU 使用量（cores）','sum(rate(container_cpu_usage_seconds_total{namespace="'+N+'",pod!=""}[2m])) by (pod)','short','{{pod}}'),('Pod memory working set','sum(container_memory_working_set_bytes{namespace="'+N+'",pod!=""}) by (pod)','bytes','{{pod}}'))
pair(('Pod ready（1=就緒）','kube_pod_status_ready{condition="true"}','short','{{pod}}'),('Pod 重啟','sum(kube_pod_container_status_restarts_total) by (pod)','short','{{pod}}'))
pair(('Deployment 可用 / 期望副本','kube_deployment_status_replicas_available','short','{{deployment}}'),('CPU throttled 比例','sum(rate(s2t_cgroup_cpu_throttled_periods_total[2m]) * on(uid) group_left(pod) kube_pod_info{namespace="'+N+'"}) by (pod) / clamp_min(sum(rate(s2t_cgroup_cpu_periods_total[2m]) * on(uid) group_left(pod) kube_pod_info{namespace="'+N+'"}) by (pod), 0.000001)','percentunit','{{pod}}'))
pair(('Pod CPU 請求','sum(kube_pod_container_resource_requests{resource="cpu"}) by (pod)','short','{{pod}}'),('PVC 請求容量','kube_persistentvolumeclaim_resource_requests_storage_bytes','bytes','{{persistentvolumeclaim}}'))
row('使用量 · 使用者與總體（來源：$caption_gateway）')
usage_description = 'Gateway 已驗證使用者的操作統計，以 NT 顯示；請求含重試、拒絕及快取命中，模型完成次數只算成功完成的實際執行。Prometheus 保留期間內的估算增量，不是計費帳本。'
def usage_stat(title, expr, unit='short', width=8, x=0):
    panel(title, expr, unit, width=width, height=4, x=x, typ='stat', description=usage_description)
    panels[-1]['targets'][0].update({'instant':True,'range':False})
    panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'blue'}
usage_stat('總體 API 請求數（所選範圍）', 'sum(increase(s2t_user_requests_total{job="$caption_gateway"}[$__range]))')
usage_stat('有請求的使用者數（所選範圍）', 'count(sum(increase(s2t_user_requests_total{job="$caption_gateway",user_id!="__overflow__"}[$__range])) by (nt) > 0)', x=8)
usage_stat('總體 ASR 音訊時數（已完成可解析 WAV 音訊）', 'sum(increase(s2t_user_audio_seconds_total{job="$caption_gateway",operation="transcriptions"}[$__range])) / 3600', 'suffix:小時', x=16)
y+=4
usage_stat('總體模型回報權杖數（token）（翻譯／摘要）', 'sum(increase(s2t_user_input_tokens_total{job="$caption_gateway"}[$__range])) + sum(increase(s2t_user_output_tokens_total{job="$caption_gateway"}[$__range]))')
usage_stat('模型未回報 權杖用量的完成次數', 'sum(increase(s2t_user_token_usage_missing_total{job="$caption_gateway"}[$__range]))', x=8)
usage_stat('音訊時長未知次數（不估算成 0 秒）', 'sum(increase(s2t_user_audio_duration_unknown_total{job="$caption_gateway"}[$__range]))', x=16)
y+=4
usage_stat('目前 gateway 程序累計 請求（不受時間範圍影響）', 'sum(s2t_user_requests_total{job="$caption_gateway"})', width=24)
y+=4
for x, (title, expression) in enumerate([
    ('使用者請求數比較（依 NT）', 'sum(increase(s2t_user_requests_total{job="$caption_gateway",nt=~"$usage_user",department=~"$usage_department"}[$__range])) by (nt)'),
    ('使用者權杖用量比較（依 NT）', 'sum(increase(s2t_user_input_tokens_total{job="$caption_gateway",nt=~"$usage_user",department=~"$usage_department"}[$__range])) by (nt) + sum(increase(s2t_user_output_tokens_total{job="$caption_gateway",nt=~"$usage_user",department=~"$usage_department"}[$__range])) by (nt)')]):
    panel(title, expression, 'short', '{{nt}}', width=12, height=5, typ='bargauge', x=x*12, description=usage_description)
    panels[-1]['targets'][0].update({'instant':True,'range':False})
    panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'blue'}
    panels[-1]['options']={'orientation':'horizontal','displayMode':'gradient','showUnfilled':True,'reduceOptions':{'calcs':['last'],'fields':'','values':False}}
y+=5
for title, metric_name, unit in [('每位使用者 請求（含字幕遙測與資料 API）', 'requests', 'short'), ('每位使用者 請求處理耗時', 'request_seconds', 's'), ('每位使用者實際成功模型完成次數', 'model_executions', 'short'), ('每位使用者 ASR 音訊秒數（已完成可解析 WAV 音訊）', 'audio_seconds', 's'), ('每位使用者 ASR 音訊 位元組（已完成）', 'audio_bytes', 'bytes'), ('每位使用者翻譯／摘要輸入 權杖數（token）', 'input_tokens', 'short'), ('每位使用者翻譯／摘要輸出 權杖數（token）', 'output_tokens', 'short'), ('每位使用者輸入字元（含模型提示詞）', 'input_characters', 'short'), ('每位使用者輸出字元', 'output_characters', 'short')]:
    operation_filter = {'model_executions':',operation=~"transcriptions|translations|summaries"', 'audio_seconds':',operation="transcriptions"', 'audio_bytes':',operation="transcriptions"', 'input_tokens':',operation=~"translations|summaries"', 'output_tokens':',operation=~"translations|summaries"', 'input_characters':',operation=~"translations|summaries"', 'output_characters':',operation=~"transcriptions|translations|summaries"'}.get(metric_name, '')
    panel(title, f'sum(increase(s2t_user_{metric_name}_total{{job="$caption_gateway",nt=~"$usage_user",nt!="",department=~"$usage_department",department!=""{operation_filter}}}[$__range])) by (department,nt,operation)', unit, '{{nt}} · {{operation}}', width=24, height=5, typ='table', description=usage_description)
    panels[-1]['targets'][0].update({'instant':True,'range':False,'format':'table'})
    panels[-1]['options']={'showHeader':True}
    y+=5
panel('每位使用者 request 結果（成功／4xx／5xx／中斷）', 'sum(increase(s2t_user_requests_total{job="$caption_gateway",nt=~"$usage_user",nt!="",department=~"$usage_department",department!=""}[$__range])) by (department,nt,operation,outcome)', 'short', '{{nt}} · {{operation}} · {{outcome}}', width=24, height=5, typ='table', description=usage_description)
panels[-1]['targets'][0].update({'instant':True,'range':False,'format':'table'})
panels[-1]['options']={'showHeader':True}
y+=5
pair(('使用者請求速率（含字幕遙測）', 'sum(rate(s2t_user_requests_total{job="$caption_gateway",nt=~"$usage_user",nt!="",department=~"$usage_department",department!=""}[$__rate_interval])) by (nt)', 'reqps', '{{nt}}'), ('使用者請求錯誤率（含拒絕／中斷）', 'sum(rate(s2t_user_requests_total{job="$caption_gateway",nt=~"$usage_user",nt!="",department=~"$usage_department",department!="",outcome!="success"}[$__rate_interval])) by (nt) / sum(rate(s2t_user_requests_total{job="$caption_gateway",nt=~"$usage_user",nt!="",department=~"$usage_department",department!=""}[$__rate_interval])) by (nt)', 'percentunit', '{{nt}}'))
row('部門總體用量 · 依部門彙總（來源：$caption_gateway）')
for index, (title, expression, unit) in enumerate([
    ('各部門請求數（所選範圍）', 'sum(increase(s2t_user_requests_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__range])) by (department)', 'short'),
    ('各部門成功模型完成次數', 'sum(increase(s2t_user_model_executions_total{job="$caption_gateway",department=~"$usage_department",department!="",operation=~"transcriptions|translations|summaries"}[$__range])) by (department)', 'short'),
    ('各部門 ASR 音訊時數', 'sum(increase(s2t_user_audio_seconds_total{job="$caption_gateway",department=~"$usage_department",department!="",operation="transcriptions"}[$__range])) by (department) / 3600', 'suffix:小時'),
    ('各部門輸入權杖數（token）', 'sum(increase(s2t_user_input_tokens_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__range])) by (department)', 'short'),
    ('各部門輸出權杖數（token）', 'sum(increase(s2t_user_output_tokens_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__range])) by (department)', 'short'),
    ('各部門請求錯誤率', 'sum(increase(s2t_user_requests_total{job="$caption_gateway",department=~"$usage_department",department!="",outcome!="success"}[$__range])) by (department) / sum(increase(s2t_user_requests_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__range])) by (department)', 'percentunit')]):
    panel(title, expression, unit, '{{department}}', width=12, height=5, typ='bargauge', description='以帳號已驗證的部門彙總，不受 NT 篩選影響；使用所選時間範圍。', x=(index % 2)*12)
    panels[-1]['targets'][0].update({'instant':True,'range':False})
    panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'blue'}
    panels[-1]['options']={'orientation':'horizontal','displayMode':'gradient','showUnfilled':True,'reduceOptions':{'calcs':['last'],'fields':'','values':False}}
    if panels[-1]['gridPos']['x'] == 12: y+=5
# Keep the following rows below the last gauge pair.
y = max(y, max(entry['gridPos']['y']+entry['gridPos']['h'] for entry in panels))
row('部門與使用者請求趨勢')
pair(('部門請求速率', 'sum(rate(s2t_user_requests_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__rate_interval])) by (department)', 'reqps', '{{department}}'), ('部門權杖使用速率', '(sum(rate(s2t_user_input_tokens_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__rate_interval])) by (department)) + (sum(rate(s2t_user_output_tokens_total{job="$caption_gateway",department=~"$usage_department",department!=""}[$__rate_interval])) by (department))', 'short', '{{department}}'))
for entry in panels:
    for target in entry.get('targets', []):
        if 's2t_user_' in target['expr']:
            target['expr'] = target['expr'].replace(',nt!=""', '').replace(',department!=""', '').replace('job="$caption_gateway"', 'job="$caption_gateway",nt!="",department!=""')
    if entry['type'] == 'table' and 's2t_user_' in entry['targets'][0]['expr']:
        entry['transformations'] = [{'id':'organize','options':{'excludeByName':{'Time':True},'renameByName':{'nt':'使用者 NT','department':'部門','operation':'操作','outcome':'結果','Value':'用量'}}}]
        entry['fieldConfig']['defaults']['decimals'] = 2
        entry['fieldConfig']['overrides'] += [
            {'matcher':{'id':'byName','options':'操作'},'properties':[{'id':'mappings','value':[{'type':'value','options':{key:{'text':text} for key,text in [('transcriptions','語音辨識'),('translations','翻譯'),('summaries','摘要'),('diarizations','講者分離'),('telemetry/captions','字幕遙測'),('config','服務設定'),('data/sessions','會議紀錄'),('auth/session','登入狀態'),('other','其他操作'),('storage','儲存服務'),('audio/object','錄音檔案'),('data/settings','使用者設定'),('data/glossary','詞彙表'),('data/voiceprints','聲紋資料'),('data/diarization-jobs','講者分離工作'),('data/storage-status','儲存狀態'),('data/storage-audit','儲存稽核'),('data/storage-retry','儲存重試'),('data/model-registry','模型設定'),('data/model-health','模型健康狀態'),('data/model-credentials/id','模型憑證設定'),('data/summary-templates','摘要模板'),('auth/logout','登出'),('admin/users','帳號管理'),('audio-processing/silero-vad','語音活動偵測'),('audio-processing/status','音訊處理狀態'),('audio-processing/import-wav','匯入音訊')]}}]}]},
            {'matcher':{'id':'byName','options':'結果'},'properties':[{'id':'mappings','value':[{'type':'value','options':{key:{'text':text} for key,text in [('success','成功'),('client_error','請求錯誤（4xx）'),('server_error','服務錯誤（5xx）'),('aborted','連線中斷')]}}]}]}
        ]
dashboard={'uid':'s2t-overview','title':'S2T · 一張總覽 / ASR·翻譯瓶頸與服務健康','schemaVersion':41,'version':1,'timezone':'browser','refresh':'5s','time':{'from':'now-15m','to':'now'},'tags':['S2T','Web','K8s'],'panels':panels,'editable':False}
# Caption panels must never combine real users with the isolated load generator.
import re
for entry in panels:
    for target in entry.get('targets', []):
        target['expr'] = re.sub(r'(s2t_(?:caption_stage_duration_seconds|caption_events_total|server_stage_duration_seconds|gateway_request_duration_seconds|gateway_request_errors_total|gateway_inflight_requests|diarization_pending_jobs|diarization_oldest_seconds|storage_operation_duration_seconds)(?:_bucket|_sum|_count|_errors_total)?)(\{)?', lambda match: match.group(1) + '{job="$caption_gateway"' + (',' if match.group(2) else '}'), target['expr'])
    if entry['type'] == 'row' and entry['title'].startswith(('00 ', '01 ', '02 ', '03 ')):
        if '來源：$caption_gateway' not in entry['title']: entry['title'] += ' · 來源：$caption_gateway'
dashboard['templating'] = {'list': [{'name': 'datasource', 'label': '資料來源', 'type': 'datasource', 'query': 'prometheus', 'regex': '', 'current': {'text': 'Prometheus', 'value': 's2t-prometheus'}, 'options': [], 'multi': False, 'includeAll': False}, {'name': 'caption_gateway', 'label': '字幕量測來源', 'type': 'custom', 'query': '8787 網頁入口 : gateway-web,K8s 測試站 : s2t,驗收模擬資料（非正式） : gateway-acceptance', 'current': {'text': '8787 網頁入口' if external_gateway else 'K8s 測試站', 'value': 'gateway-web' if external_gateway else 's2t'}, 'options': [{'text': '8787 網頁入口', 'value': 'gateway-web', 'selected': bool(external_gateway)}, {'text': 'K8s 測試站', 'value': 's2t', 'selected': not bool(external_gateway)}, {'text':'驗收模擬資料（非正式）','value':'gateway-acceptance','selected':False}], 'multi': False, 'includeAll': False}]}
dashboard['templating']['list'].append({'name':'usage_department','label':'部門','type':'query','datasource':DS,'query':'label_values(s2t_user_requests_total{job="$caption_gateway",department!=""}, department)','refresh':2,'multi':True,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'}})
dashboard['templating']['list'].append({'name':'usage_user','label':'使用量 NT','type':'query','datasource':DS,'query':'label_values(s2t_user_requests_total{job="$caption_gateway",department=~"$usage_department",department!=""}, nt)','refresh':2,'multi':True,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'}})
Path(__file__).with_name('dashboard.json').write_text(json.dumps(dashboard,ensure_ascii=False,indent=2)+'\n')
from oncall import build_oncall
oncall = build_oncall(dashboard)
Path(__file__).with_name('oncall.json').write_text(json.dumps(oncall,ensure_ascii=False,indent=2)+'\n')
cm('s2t-dashboard',{'dashboard.json':json.dumps(dashboard,ensure_ascii=False),'oncall.json':json.dumps(oncall,ensure_ascii=False)})
deploy('grafana','grafana/grafana:12.2.0',3000,env=[{'name':'PROMETHEUS_URL','valueFrom':{'configMapKeyRef':{'name':'monitoring-connection','key':'PROMETHEUS_URL'}}},secretEnv('GF_SECURITY_ADMIN_PASSWORD','grafana-password'),{'name':'GF_USERS_ALLOW_SIGN_UP','value':'false'},{'name':'GF_AUTH_ANONYMOUS_ENABLED','value':'true'},{'name':'GF_AUTH_ANONYMOUS_ORG_ROLE','value':'Viewer'},{'name':'GF_ANALYTICS_REPORTING_ENABLED','value':'false'},{'name':'GF_ANALYTICS_CHECK_FOR_UPDATES','value':'false'},{'name':'GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH','value':'/var/lib/grafana/dashboards/dashboard.json'}],volumes=[{'name':'data','persistentVolumeClaim':{'claimName':'grafana-data'}},{'name':'provisioning','configMap':{'name':'grafana-provisioning'}},{'name':'dashboards','configMap':{'name':'s2t-dashboard'}}],mounts=[{'name':'data','mountPath':'/var/lib/grafana'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/datasources/datasources.yaml','subPath':'datasources.yaml'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/dashboards/dashboards.yaml','subPath':'dashboards.yaml'},{'name':'dashboards','mountPath':'/var/lib/grafana/dashboards'}],cpu='100m',mem='128Mi')
items[-2]['spec']['template']['spec']['securityContext']={'fsGroup':472,'runAsUser':472}
Path(__file__).with_name('stack.json').write_text(json.dumps({'apiVersion':'v1','kind':'List','items':items},indent=2)+'\n')
