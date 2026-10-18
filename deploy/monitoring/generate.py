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
for name in ['prometheus','grafana']:add('PersistentVolumeClaim',name+'-data',{'accessModes':['ReadWriteOnce'],'resources':{'requests':{'storage':'10Gi' if name == 'prometheus' else '2Gi'}}})
deploy('prometheus','prom/prometheus:v3.5.0',9090,args=['--config.file=/etc/prometheus/prometheus.yml','--storage.tsdb.path=/prometheus','--storage.tsdb.retention.time=90d','--storage.tsdb.retention.size=8GB'],volumes=[{'name':'config','configMap':{'name':'prometheus-config'}},{'name':'data','persistentVolumeClaim':{'claimName':'prometheus-data'}}],mounts=[{'name':'config','mountPath':'/etc/prometheus'},{'name':'data','mountPath':'/prometheus'}],cpu='100m',mem='192Mi',serviceAccount='prometheus')
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
row('00 · KPI · 來源：$caption_gateway')
panel('E2E P90 · 最後語音 → 譯文呈現（目標 < 3 秒）', 'histogram_quantile(0.90, sum(rate(s2t_caption_stage_duration_seconds_bucket{stage="e2e_translation_tail"}[$__rate_interval])) by (le))', 's', width=8, height=5, typ='stat', description='所選時間區間；最後 VAD 語音樣本到該段譯文於可見即時頁呈現，包含斷句等待。VAD 為語音尾端估計，非逐字對齊；翻譯關閉或無樣本時無資料。')
instant()
panels[-1]['fieldConfig']['defaults'].update({'color':{'mode':'thresholds'},'thresholds':{'mode':'absolute','steps':[{'color':'green','value':None},{'color':'red','value':3}]}})
panel('瓶頸段延遲 · t1～t7 平均（所選區間）', 'sum by (phase) (rate(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[1-7]"}[$__rate_interval])) / sum by (phase) (rate(s2t_caption_phase_duration_seconds_count{job="$caption_gateway",phase=~"t[1-7]"}[$__rate_interval]))', 's', '{{phase}}', width=8, height=5, x=8, typ='bargauge', description='每階段平均；各階段的子切片先由瀏覽器合併成每段一個 phase 樣本。ASR 與翻譯樣本數可能不同，勿將平均相加當 E2E。')
instant(); bargauge(); labels(PHASE_LABELS)
panel('API 成功率（所選區間）', '1 - sum(rate(s2t_gateway_request_errors_total[$__rate_interval])) / sum(rate(s2t_gateway_request_duration_seconds_count[$__rate_interval]))', 'percentunit', width=8, height=5, x=16, typ='stat', description='HTTP 狀態 < 400 / 全部完成請求；無請求時無資料。')
instant()
y+=5

row('01 · ASR 瓶頸分析 — 語音起點 → 原文呈現（t1~t5）· 來源：$caption_gateway')
panel('ASR 階段平均耗時（所選範圍）· 最長者即瓶頸',
      'sort_desc(sum by (phase) (increase(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[1-5]"}[$__range])) / sum by (phase) (increase(s2t_caption_phase_duration_seconds_count{job="$caption_gateway",phase=~"t[1-5]"}[$__range])))',
      's', '{{phase}}', width=8, height=8, x=0, typ='bargauge',
      description='t1 音訊擷取上傳／t2 VAD 與分段／t3 ASR 模型推論／t4 文字後處理／t5 回傳與呈現 的平均耗時，由長到短排列：最長的一根就是瓶頸。t3 最大＝模型推論吃緊；t1 大＝上傳或編碼；t5 大＝回傳網路與重試；t2 大＝分段累積或 VAD 確認慢。')
bargauge(); labels(PHASE_LABELS)
panel('ASR 階段耗時占比（所選範圍）',
      'sum by (phase) (increase(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[1-5]"}[$__range])) / scalar(sum(increase(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[1-5]"}[$__range])))',
      'percentunit', '{{phase}}', width=8, height=8, x=8, typ='piechart', description='同一批樣本的耗時占比（不是分位數的拆分）；配合左側長條圖判讀瓶頸佔了多少比例。')
instant()
panels[-1]['options']={'pieType':'donut','displayLabels':['percent'],'reduceOptions':{'calcs':['last'],'fields':'','values':False},'legend':{'displayMode':'table','placement':'right','values':['value'],'showLegend':True}}
labels(PHASE_LABELS)
panel('ASR 明細平均耗時（每個細項，所選範圍）',
      'sort_desc(sum by (stage) (increase(s2t_caption_stage_duration_seconds_sum{stage=~"t[1-5]_.*"}[$__range])) / sum by (stage) (increase(s2t_caption_stage_duration_seconds_count{stage=~"t[1-5]_.*"}[$__range])))',
      's', '{{stage}}', width=8, height=8, x=16, typ='bargauge', description='確認最長階段後，用這根定位到原子量測：佇列、編碼、上傳、VAD、排隊、模型推論、後處理、網路、呈現。0 秒的可選步驟（如未啟用的前處理）不會輸出樣本。')
bargauge(); labels(STAGE_LABELS)
y+=8
panel('ASR t1～t5 每分鐘平均耗時',
      'sum by (phase) (rate(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[1-5]"}[1m])) / sum by (phase) (rate(s2t_caption_phase_duration_seconds_count{job="$caption_gateway",phase=~"t[1-5]"}[1m]))',
      's', '{{phase}}', width=12, height=8, x=0, typ='timeseries',
      description='每個階段一條折線，顯示該分鐘完整 phase 樣本的平均耗時（sum/count）。橫軸跟隨上方所選時間區間；固定 1 分鐘取樣，沒有樣本的分鐘留白。')
panels[-1]['interval']='1m'
panels[-1]['maxDataPoints']=11000
panels[-1]['targets'][0].update({'interval':'1m','range':True,'instant':False})
panels[-1]['fieldConfig']['defaults'].update({'color':{'mode':'palette-classic'},'custom':{'drawStyle':'line','lineWidth':2,'showPoints':'always','pointSize':3,'spanNulls':False,'stacking':{'mode':'none','group':'A'}}})
panels[-1]['options']['legend']={'displayMode':'list','placement':'bottom','showLegend':True}
labels(PHASE_LABELS)
panel('ASR 各階段平均耗時趨勢（堆疊）',
      'sum by (phase) (rate(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[1-5]"}[$__rate_interval])) / sum by (phase) (rate(s2t_caption_phase_duration_seconds_count{job="$caption_gateway",phase=~"t[1-5]"}[$__rate_interval]))',
      's', '{{phase}}', width=12, height=8, x=12, typ='timeseries', description='所選區間內各取樣窗口的平均耗時，堆疊總高近似每段請求的平均時間；哪一層突然變厚，就是新出現的瓶頸。無語音樣本的時間保留空白；一週視窗內若只有短暫測試，資料會集中在右側，以圓點標示稀疏樣本。')
panels[-1]['fieldConfig']['defaults'].update({'color':{'mode':'palette-classic'},'custom':{'drawStyle':'line','lineInterpolation':'linear','lineWidth':2,'fillOpacity':50,'showPoints':'always','pointSize':5,'spanNulls':False,'stacking':{'mode':'normal','group':'A'}}})
panels[-1]['maxDataPoints']=10000
panels[-1]['options']['legend']={'displayMode':'list','placement':'bottom','showLegend':True}
labels(PHASE_LABELS)
y+=8
panel('有效 ASR 端到端樣本（所選範圍）', 'sum(increase(s2t_caption_stage_duration_seconds_count{stage="e2e_asr"}[$__range]))', width=8, height=5, x=0, typ='stat', description='沒有樣本時，上面的分位數與瓶頸判讀都不可信。')
instant(); panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'text'}
panel('ASR 事件（語音偵測／無文字／失敗／缺口）', 'sum(increase(s2t_caption_events_total[$__rate_interval])) by (event)', 'short', '{{event}}', width=16, height=5, x=8, typ='timeseries', description='asr_failed／asr_empty／audio_gap／silero_veto 等事件；失敗請求不進延遲樣本，必須從這裡觀察，否則分位數會過於樂觀。')
panels[-1]['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
y+=5

row('02 · 翻譯管線 — 原文 → 譯文呈現（t6~t7）· 來源：$caption_gateway')
for x,q in enumerate([.5,.95,.99]):
    panel(f'翻譯 語音→譯文 P{int(q*100)}', f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_translation"}}[$__rate_interval])) by (le))', 's', width=6, height=4, x=x*6, typ='stat', description='語音起點到譯文在 UI 呈現（含前段 ASR 等待）；所選時間區間。')
    instant()
panel('有效翻譯樣本（所選區間）', 'sum(increase(s2t_caption_stage_duration_seconds_count{stage="e2e_translation"}[$__rate_interval]))', width=6, height=4, x=18, typ='stat', description='無樣本時分位數不可信；翻譯未啟用時本列會無資料。')
instant(); panels[-1]['fieldConfig']['defaults']['color']={'mode':'fixed','fixedColor':'text'}
y+=4
panel('翻譯階段平均耗時（所選範圍）',
      'sort_desc(sum by (phase) (increase(s2t_caption_phase_duration_seconds_sum{job="$caption_gateway",phase=~"t[67]"}[$__range])) / sum by (phase) (increase(s2t_caption_phase_duration_seconds_count{job="$caption_gateway",phase=~"t[67]"}[$__range])))',
      's', '{{phase}}', width=12, height=6, x=0, typ='bargauge', description='t6 排隊等待＋容量排隊＋翻譯模型推論＋伺服器固定處理；t7 回傳網路與譯文呈現。t6_wait 長代表前端排隊，t6_model 長代表模型吃緊。')
bargauge(); labels(PHASE_LABELS)
panel('翻譯端到端延遲趨勢 P50／P95／P99', '', 's', width=12, height=6, x=12, typ='timeseries', description='語音起點到譯文呈現的分位數趨勢（依所選區間自動調整取樣窗口）。')
panels[-1]['targets']=[{'refId':str(i),'expr':f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="e2e_translation"}}[$__rate_interval])) by (le))','legendFormat':f'P{int(q*100)}','range':True,'instant':False} for i,q in enumerate([.5,.95,.99])]
panels[-1]['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
y+=6

row('03 · Gateway / Audio worker · 交叉驗證（伺服器端與 t1_upload、t3、t6 對應）')
pair(('Gateway 伺服器階段 p95（與瀏覽器切片同源，勿加總）','histogram_quantile(0.95, sum(rate(s2t_server_stage_duration_seconds_bucket[$__rate_interval])) by (stage,le))','s','{{stage}}'),('字幕繪出樣本 / 秒','sum(rate(s2t_caption_stage_duration_seconds_count{stage="e2e_asr"}[$__rate_interval]))'))
pair(('HTTP 路由 p95','histogram_quantile(0.95, sum(rate(s2t_gateway_request_duration_seconds_bucket[$__rate_interval])) by (route,le))','s','{{route}}'),('HTTP 吞吐 / 秒','sum(rate(s2t_gateway_request_duration_seconds_count[$__rate_interval])) by (route)','reqps','{{route}}'))
panel('服務進行中請求', 's2t_gateway_inflight_requests', 'short', '{{service}} {{pod}}', width=24)
y+=7
pair(('程序 RSS','s2t_process_resident_memory_bytes','bytes','{{service}} {{pod}}'),('Event loop p99','s2t_event_loop_p99_seconds','s','{{service}} {{pod}}'))
pair(('Diarization 待處理工作 / 最老秒數','max(s2t_diarization_pending_jobs)','short'),('Diarization 最老等待','max(s2t_diarization_oldest_seconds)','s'))
row('04 · Storage 健康狀態')
for index, (name, expr) in enumerate([
    ('PostgreSQL', 'min(pg_up{job="postgres"})'),
    ('Redis', 'min(redis_up{job="redis"})'),
    ('Sentinel', 'min(redis_sentinel_master_ckquorum_status{job="sentinel"}) * (1 - max(redis_sentinel_tilt{job="sentinel"}))'),
    ('MinIO', 'min(up{job="minio"})'),
    ('Milvus', 'min(up{job="milvus"})'),
    ('etcd', 'min(etcd_server_has_leader{job="etcd"})')]):
    panel(name + ' healthy', expr, width=4, height=4, x=index*4, typ='stat', description='1=健康，0=異常；缺失顯示無資料。MinIO／Milvus 此處只確認 metrics endpoint 可達，不代表完整讀寫驗證。')
    instant()
    panels[-1]['fieldConfig']['defaults']['mappings']=[{'type':'value','options':{'0':{'text':'異常','color':'red'},'1':{'text':'Healthy','color':'green'}}}]
y+=4
row('部門 · 使用趨勢與轉換（L2 = 按開始錄音）')
journey_filter = 'job="$caption_gateway",department=~"${usage_department:regex}",user_id!="__overflow__"'
weekly_users = f'count by (department) (sum by (department,user_id) (increase(s2t_user_journey_events_total{{{journey_filter},stage="L2"}}[$__interval])) > 0)'
weekly_uses = f'sum by (department) (increase(s2t_user_journey_events_total{{{journey_filter},stage="L2"}}[$__interval]))'
for index,(title,expr) in enumerate([('使用人數趨勢 · L2 不重複使用者', weekly_users), ('使用次數趨勢 · L2 按鈕次數', weekly_uses)]):
    panel(title, expr, 'short', '{{department}}', width=12, height=7, x=index*12, description='Asia/Taipei；橫軸使用所選區間，每點統計自動取樣窗口內的資料。All 每條線一部門；選部門只顯示該部門。不受 NT 篩選影響。新部署前無歷史事件，第一週為部分資料。')
    panels[-1]['interval']='15s'
    panels[-1]['targets'][0].update({'range':True,'instant':False})
    panels[-1]['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
y+=7
panel('使用漏斗 · Total（所選期間／部門，不重複人數）', '', 'short', width=12, height=7, typ='bargauge', description='原生水平階段漏斗。L1 進站；L2 按開始錄音；L3 開啟紀錄或摘要且載入非空內容。各階段採同期間不重複使用者，非有序 cohort；跨週或既有使用者可使轉換率超過 100%。All 合計全部門。')
funnel_counts={stage:f'count(sum by (user_id) (increase(s2t_user_journey_events_total{{{journey_filter},stage="{stage}"}}[$__range])) > 0)' for stage in ['L1','L2','L3']}
panels[-1]['targets']=[{'refId':stage,'expr':expr,'legendFormat':stage,'instant':True,'range':False} for stage,expr in funnel_counts.items()]
bargauge()
labels({'L1':'L1 進站','L2':'L2 使用','L3':'L3 產出'})
panel('漏斗轉換率 · Total（所選期間／部門）', '', 'percentunit', width=12, height=7, x=12, typ='stat', description='同期間不重複人數比率；分母為零時無資料，不補成 0%。非有序 cohort。')
panels[-1]['targets']=[{'refId':a+b,'expr':f'({funnel_counts[b]}) / ({funnel_counts[a]})','legendFormat':a+' → '+b,'instant':True,'range':False} for a,b in [('L1','L2'),('L2','L3'),('L1','L3')]]
y+=7
row('使用者用量 · 依 NT 趨勢（來源：$caption_gateway）')
panel('使用次數趨勢 · 每個 NT 一條線（L2）',
      'sum by (nt) (increase(s2t_user_journey_events_total{job="$caption_gateway",stage="L2",nt=~"${usage_user:regex}",department=~"${usage_department:regex}",user_id!="__overflow__"}[$__interval]))',
      'short', '{{nt}}', width=24, height=8,
      description='以 L2 按開始／繼續錄音計算；每條線是一個 NT。部門與 NT 選 All 看全部，指定條件則只顯示符合的使用者。橫軸使用所選區間，取樣窗口自動調整；新部署前無事件歷史。')
panels[-1]['interval']='15s'
panels[-1]['targets'][0].update({'range':True,'instant':False})
panels[-1]['fieldConfig']['defaults'].update({'decimals':0,'color':{'mode':'palette-classic'},'custom':{'drawStyle':'line','showPoints':'always','spanNulls':False}})
y+=8
row('HTTP 錯誤 · 依 NT 分類（來源：$caption_gateway）')
for index, (status_class, outcome) in enumerate([('4xx', 'client_error'), ('5xx', 'server_error')]):
    panel(f'HTTP {status_class} 次數 · 每個 NT 一條線',
          f'sum by (nt) (increase(s2t_user_requests_total{{job="$caption_gateway",outcome="{outcome}",nt=~"${{usage_user:regex}}",department=~"${{usage_department:regex}}",user_id!="__overflow__"}}[$__interval]))',
          'short', '{{nt}}', width=12, height=8, x=index*12,
          description=f'已登入且可歸屬 NT 的 HTTP {status_class} 回應次數；橫軸使用所選區間，每點統計自動取樣窗口內的資料。每個 NT 一條線，可依部門／NT 篩選。未登入請求及連線中斷不歸入此圖；這是錯誤次數，不是錯誤率。')
    panels[-1]['interval']='15s'
    panels[-1]['targets'][0].update({'range':True,'instant':False})
    panels[-1]['fieldConfig']['defaults'].update({'decimals':0,'color':{'mode':'palette-classic'},'custom':{'drawStyle':'line','showPoints':'always','spanNulls':False}})
y+=8
dashboard={'uid':'s2t-overview','title':'S2T · 一張總覽 / ASR·翻譯瓶頸與服務健康','schemaVersion':41,'version':1,'timezone':'Asia/Taipei','refresh':'30s','time':{'from':'now-7d','to':'now'},'tags':['S2T','Web'],'panels':panels,'editable':False}
# Caption panels must never combine real users with the isolated load generator.
import re
for entry in panels:
    for target in entry.get('targets', []):
        target['expr'] = re.sub(r'(s2t_(?:caption_stage_duration_seconds|caption_events_total|server_stage_duration_seconds|gateway_request_duration_seconds|gateway_request_errors_total|gateway_inflight_requests|diarization_pending_jobs|diarization_oldest_seconds|storage_operation_duration_seconds)(?:_bucket|_sum|_count|_errors_total)?)(\{)?', lambda match: match.group(1) + '{job="$caption_gateway"' + (',' if match.group(2) else '}'), target['expr'])
    if entry['type'] == 'row' and entry['title'].startswith(('00 ', '01 ', '02 ', '03 ')):
        if '來源：$caption_gateway' not in entry['title']: entry['title'] += ' · 來源：$caption_gateway'
dashboard['templating'] = {'list': [{'name': 'datasource', 'label': '資料來源', 'type': 'datasource', 'query': 'prometheus', 'regex': '', 'current': {'text': 'Prometheus', 'value': 's2t-prometheus'}, 'options': [], 'multi': False, 'includeAll': False}, {'name': 'caption_gateway', 'label': '字幕量測來源', 'type': 'custom', 'query': '8787 網頁入口 : gateway-web', 'current': {'text': '8787 網頁入口', 'value': 'gateway-web'}, 'options': [{'text': '8787 網頁入口', 'value': 'gateway-web', 'selected': True}], 'multi': False, 'includeAll': False}]}
dashboard['templating']['list'].append({'name':'usage_department','label':'部門','type':'query','datasource':DS,'query':'label_values(s2t_user_requests_total{job="$caption_gateway",department!=""}, department)','refresh':2,'multi':False,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'}})
dashboard['templating']['list'].append({'name':'usage_user','label':'使用量 NT','type':'query','datasource':DS,'query':'label_values(s2t_user_requests_total{job="$caption_gateway",department=~"$usage_department",department!=""}, nt)','refresh':2,'multi':True,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'}})
# Hide model mocks and preview infrastructure from the real service resource charts.
for entry in panels:
    for target in entry.get('targets', []):
        target['expr'] = target['expr'].replace('pod!=""', 'pod!="",pod!~"mock-models.*|monitoring-acceptance.*|report-preview.*"')
        target['expr'] = target['expr'].replace('kube_pod_status_ready{', 'kube_pod_status_ready{pod!~"mock-models.*|monitoring-acceptance.*|report-preview.*",')
        target['expr'] = target['expr'].replace('kube_pod_container_status_restarts_total)', 'kube_pod_container_status_restarts_total{pod!~"mock-models.*|monitoring-acceptance.*|report-preview.*"})')
        target['expr'] = target['expr'].replace('kube_deployment_status_replicas_available', 'kube_deployment_status_replicas_available{deployment!~"mock-models.*|monitoring-acceptance.*|report-preview.*"}')
        for name in ['s2t_process_resident_memory_bytes', 's2t_event_loop_p99_seconds']:
            target['expr'] = target['expr'].replace(name, name+'{job="$caption_gateway"}')
# One time picker governs all panels. Summary panels query the selected end
# and aggregate over the full selected range; trends keep adaptive windows.
for entry in panels:
    entry.pop('timeFrom', None)
    entry.pop('timeShift', None)
    for target in entry.get('targets', []):
        if entry['title'] != 'ASR t1～t5 每分鐘平均耗時':
            target.pop('interval', None)
        if entry['type'] in ('stat', 'bargauge', 'piechart'):
            target['expr'] = target['expr'].replace('[$__rate_interval]', '[$__range]').replace('[$__interval]', '[$__range]')
            target.update({'instant':True,'range':False})
            entry['options'].setdefault('reduceOptions', {})['calcs']=['last']
        else:
            target.update({'instant':False,'range':True})
            entry.setdefault('interval', '15s')
dashboard['templating']['list'].sort(key=lambda item: 0 if item['name']=='usage_department' else 1)
Path(__file__).with_name('dashboard.json').write_text(json.dumps(dashboard,ensure_ascii=False,indent=2)+'\n')
from oncall import build_oncall
oncall = build_oncall(dashboard)
Path(__file__).with_name('oncall.json').write_text(json.dumps(oncall,ensure_ascii=False,indent=2)+'\n')
cm('s2t-dashboard',{'dashboard.json':json.dumps(dashboard,ensure_ascii=False),'oncall.json':json.dumps(oncall,ensure_ascii=False)})
deploy('grafana','grafana/grafana:12.2.0',3000,env=[{'name':'PROMETHEUS_URL','valueFrom':{'configMapKeyRef':{'name':'monitoring-connection','key':'PROMETHEUS_URL'}}},secretEnv('GF_SECURITY_ADMIN_PASSWORD','grafana-password'),{'name':'GF_USERS_ALLOW_SIGN_UP','value':'false'},{'name':'GF_AUTH_ANONYMOUS_ENABLED','value':'true'},{'name':'GF_AUTH_ANONYMOUS_ORG_ROLE','value':'Viewer'},{'name':'GF_ANALYTICS_REPORTING_ENABLED','value':'false'},{'name':'GF_ANALYTICS_CHECK_FOR_UPDATES','value':'false'},{'name':'GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH','value':'/var/lib/grafana/dashboards/dashboard.json'}],volumes=[{'name':'data','persistentVolumeClaim':{'claimName':'grafana-data'}},{'name':'provisioning','configMap':{'name':'grafana-provisioning'}},{'name':'dashboards','configMap':{'name':'s2t-dashboard'}}],mounts=[{'name':'data','mountPath':'/var/lib/grafana'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/datasources/datasources.yaml','subPath':'datasources.yaml'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/dashboards/dashboards.yaml','subPath':'dashboards.yaml'},{'name':'dashboards','mountPath':'/var/lib/grafana/dashboards'}],cpu='100m',mem='128Mi')
items[-2]['spec']['template']['spec']['securityContext']={'fsGroup':472,'runAsUser':472}
Path(__file__).with_name('stack.json').write_text(json.dumps({'apiVersion':'v1','kind':'List','items':items},indent=2)+'\n')
