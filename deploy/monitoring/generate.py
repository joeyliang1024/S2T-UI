#!/usr/bin/env python3
"""Generate the isolated K8s monitoring stack and its single provisioned dashboard."""
import json
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
cm('prometheus-config',{'prometheus.yml':config})
for name in ['prometheus','grafana']:add('PersistentVolumeClaim',name+'-data',{'accessModes':['ReadWriteOnce'],'resources':{'requests':{'storage':'2Gi'}}})
deploy('prometheus','prom/prometheus:v3.5.0',9090,args=['--config.file=/etc/prometheus/prometheus.yml','--storage.tsdb.path=/prometheus','--storage.tsdb.retention.time=3d','--storage.tsdb.retention.size=1GB'],volumes=[{'name':'config','configMap':{'name':'prometheus-config'}},{'name':'data','persistentVolumeClaim':{'claimName':'prometheus-data'}}],mounts=[{'name':'config','mountPath':'/etc/prometheus'},{'name':'data','mountPath':'/prometheus'}],cpu='100m',mem='192Mi',serviceAccount='prometheus')
items[-2]['spec']['template']['spec']['securityContext']={'fsGroup':65534}
deploy('kube-state-metrics','registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.16.0',8080,args=['--namespaces='+N,'--resources=pods,persistentvolumeclaims,deployments,replicasets,statefulsets,daemonsets,jobs'],serviceAccount='kube-state-metrics')
deploy('postgres-exporter','quay.io/prometheuscommunity/postgres-exporter:v0.17.1',9187,env=[secretEnv('DATA_SOURCE_NAME','postgres-dsn')])
for name,key in [('redis-exporter','redis-password'),('sentinel-exporter','sentinel-password')]:
    deploy(name,'oliver006/redis_exporter:v1.88.0',9121,args=['--redis.addr='],env=[secretEnv('REDIS_PASSWORD',key)],cpu='10m')
cm('grafana-provisioning',{'datasources.yaml':'apiVersion: 1\ndatasources:\n  - name: Prometheus\n    uid: s2t-prometheus\n    type: prometheus\n    access: proxy\n    url: http://prometheus:9090\n    isDefault: true\n    jsonData: {timeInterval: 5s}\n','dashboards.yaml':'apiVersion: 1\nproviders:\n  - name: S2T\n    type: file\n    updateIntervalSeconds: 10\n    options: {path: /var/lib/grafana/dashboards}\n'})
# The single dashboard deliberately separates measured UI latency from server-only load.
panels=[]; y=0; ident=1
def panel(title,expr,unit='short',legend='',width=12,height=7,description='',typ='timeseries',x=0):
    global ident
    panels.append({'id':ident,'title':title,'type':typ,'gridPos':{'x':x,'y':y,'w':width,'h':height},'datasource':{'type':'prometheus','uid':'s2t-prometheus'},'targets':[{'refId':'A','expr':expr,'legendFormat':legend}], 'description':description,'fieldConfig':{'defaults':{'unit':unit,'min':0},'overrides':[]},'options':{'legend':{'displayMode':'table','placement':'bottom','calcs':['lastNotNull'],'height':170},'tooltip':{'mode':'multi'},'reduceOptions':{'calcs':['lastNotNull'],'fields':'','values':False}}});ident+=1
def row(title):
    global ident,y
    panels.append({'id':ident,'title':title,'type':'row','collapsed':False,'gridPos':{'x':0,'y':y,'w':24,'h':1}});ident+=1;y+=1
def pair(a,b):
    global y
    panel(*a,x=0);panel(*b,x=12);y+=7
row('01 · 使用者首字延遲 — Web 實際可見字幕；VAD 語音起點估計')
for x,q in enumerate([.5,.95,.99]):panel(f'首字 p{int(q*100)}',f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="speech_to_first_paint"}}[5m])) by (le))','s',width=6,height=4,x=x*6,typ='stat',description='每次 VAD 語音開頭到第一個非空字幕段首次可見呈現；兩次 requestAnimationFrame 估計 paint。不是第一個 ASR token，也不包含 Grafana 抓取時間。只量測 Web。')
panel('成功首字樣本（目前 Pods 累計）','sum(s2t_caption_stage_duration_seconds_count{stage="speech_to_first_paint"})',width=6,height=4,x=18,typ='stat');y+=4
panel('首字延遲時間占比（所選時間範圍）', 'sum(increase(s2t_first_word_stage_duration_seconds_sum[$__range])) by (stage) / scalar(sum(increase(s2t_first_word_stage_duration_seconds_sum[$__range])))', 'percentunit', '{{stage}}', width=24, height=8, typ='piechart', description='依上方時間選擇器，同一批已成功顯示首字的樣本，各步驟累計耗時 / 六個步驟累計耗時。不是請求數量占比；不使用 p95 相加，排除後續字幕、翻譯及與 ASR roundtrip 重疊的 server 指標。沒有有效樣本時顯示 No data。')
panels[-1]['targets'][0]['instant'] = True
panels[-1]['targets'][0]['range'] = False
panels[-1]['options'] = {'pieType':'donut','displayLabels':['percent'],'reduceOptions':{'calcs':['lastNotNull'],'fields':'','values':False},'legend':{'displayMode':'table','placement':'right','values':['value'],'showLegend':True},'tooltip':{'mode':'single'}}
panels[-1]['fieldConfig']['defaults'].update({'decimals':2,'color':{'mode':'palette-classic'}})
for name, label in [('vad_onset','VAD 語音確認'),('chunk_wait','音訊累積 / 切段'),('browser_queue','瀏覽器排隊'),('browser_preprocess','音訊前處理'),('asr_roundtrip_with_retries','ASR 往返（含 server 排隊與重試）'),('response_to_paint','字幕畫面呈現')]:
    panels[-1]['fieldConfig']['overrides'].append({'matcher':{'id':'byName','options':name},'properties':[{'id':'displayName','value':label}]})
y += 8
pair(('首字延遲分布 p50 / p95 / p99','histogram_quantile(0.95, sum(rate(s2t_caption_stage_duration_seconds_bucket{stage="speech_to_first_paint"}[5m])) by (le))','s'),('Web 階段 p95（字幕 / 翻譯）','histogram_quantile(0.95, sum(rate(s2t_caption_stage_duration_seconds_bucket{stage!~"speech_to_first_paint|speech_to_translation_paint"}[5m])) by (stage,le))','s','{{stage}}'))
# Add parallel quantiles to the first timeseries.
panels[-2]['targets']=[{'refId':str(i),'expr':f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{stage="speech_to_first_paint"}}[5m])) by (le))','legendFormat':f'p{int(q*100)}'} for i,q in enumerate([.5,.95,.99])]
pair(('Gateway 階段 p95（與 Web roundtrip 重疊，勿加總）','histogram_quantile(0.95, sum(rate(s2t_server_stage_duration_seconds_bucket[5m])) by (stage,le))','s','{{stage}}'),('可見字幕段樣本 / 秒','sum(rate(s2t_caption_stage_duration_seconds_count{stage="response_to_paint"}[5m]))'))
pair(('語音偵測 / 無文字 / 失敗 / 音訊缺口','sum(increase(s2t_caption_events_total[5m])) by (event)','short','{{event}}'),('已偵測語音（目前 Pods 累計）','sum(s2t_caption_events_total{event="speech_detected"})','short'))
row('02 · Gateway / Audio worker / 模擬模型')
pair(('HTTP 路由 p95','histogram_quantile(0.95, sum(rate(s2t_gateway_request_duration_seconds_bucket[5m])) by (route,le))','s','{{route}}'),('HTTP 吞吐 / 秒','sum(rate(s2t_gateway_request_duration_seconds_count[2m])) by (route)','reqps','{{route}}'))
pair(('HTTP 失敗 / 秒','sum(rate(s2t_gateway_request_errors_total[2m])) by (route)','reqps','{{route}}'),('服務進行中請求','s2t_gateway_inflight_requests','short','{{service}} {{pod}}'))
pair(('程序 RSS','s2t_process_resident_memory_bytes','bytes','{{service}} {{pod}}'),('Event loop p99','s2t_event_loop_p99_seconds','s','{{service}} {{pod}}'))
pair(('Diarization 待處理工作 / 最老秒數','max(s2t_diarization_pending_jobs)','short'),('Diarization 最老等待','max(s2t_diarization_oldest_seconds)','s'))
pair(('Mock 模型進行中 / 明確是模擬 API','s2t_mock_active_requests','short','{{operation}}'),('Mock 注入延遲 / 長尾','s2t_mock_configured_delay_seconds','s','{{operation}}'))
row('03 · 所有服務可用性與儲存操作')
pair(('所有 scrape targets（1=成功）','up','short','{{job}} {{instance}}'),('應用儲存操作 p95','histogram_quantile(0.95, sum(rate(s2t_storage_operation_duration_seconds_bucket[5m])) by (service,operation,le))','s','{{service}} {{operation}}'))
pair(('儲存操作失敗 / 秒','sum(rate(s2t_storage_operation_duration_seconds_errors_total[5m])) by (service,operation)','reqps','{{service}} {{operation}}'),('PostgreSQL 連線','sum(pg_stat_database_numbackends) by (datname)','short','{{datname}}'))
pair(('PostgreSQL commits / rollback 每秒','sum(rate(pg_stat_database_xact_commit[5m])) by (datname)','ops','{{datname}} commits'),('PostgreSQL rollback / deadlock 每秒','sum(rate(pg_stat_database_xact_rollback[5m])) by (datname)','ops','{{datname}} rollback'))
pair(('Redis 記憶體','redis_memory_used_bytes{job="redis"}','bytes','{{instance}}'),('Redis clients / blocked','redis_connected_clients{job="redis"}','short','{{instance}}'))
pair(('Redis replication offset','redis_master_repl_offset{job="redis"}','short','{{instance}}'),('Sentinel quorum status / TILT','redis_sentinel_master_ckquorum_status','short','{{instance}}'))
pair(('Sentinel TILT（應為 0）','redis_sentinel_tilt','short','{{instance}}'),('Redis 可用性（含密碼登入）','redis_up','short','{{job}} {{instance}}'))
pair(('MinIO 儲存用量','minio_cluster_usage_total_bytes','bytes'),('MinIO 磁碟可用量','minio_cluster_capacity_usable_free_bytes','bytes'))
pair(('Milvus process RSS','process_resident_memory_bytes{job="milvus"}','bytes'),('Milvus 載入向量數量','milvus_querynode_entity_num','short','{{collection_id}}'))
pair(('etcd leader（1=有 leader）','etcd_server_has_leader','short'),('etcd WAL fsync p95','histogram_quantile(0.95, sum(rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) by (le))','s'))
row('04 · Kubernetes Pods / 容量 / 資源')
pair(('VM node CPU cores','sum(rate(container_cpu_usage_seconds_total{id="/"}[2m]))','short'),('VM node memory','container_memory_working_set_bytes{id="/"}','bytes'))
pair(('Pod CPU 使用量（cores）','sum(rate(container_cpu_usage_seconds_total{namespace="'+N+'",pod!=""}[2m])) by (pod)','short','{{pod}}'),('Pod memory working set','sum(container_memory_working_set_bytes{namespace="'+N+'",pod!=""}) by (pod)','bytes','{{pod}}'))
pair(('Pod ready（1=就緒）','kube_pod_status_ready{condition="true"}','short','{{pod}}'),('Pod 重啟','sum(kube_pod_container_status_restarts_total) by (pod)','short','{{pod}}'))
pair(('Deployment 可用 / 期望副本','kube_deployment_status_replicas_available','short','{{deployment}}'),('CPU throttled 比例','sum(rate(s2t_cgroup_cpu_throttled_periods_total[2m]) * on(uid) group_left(pod) kube_pod_info{namespace="'+N+'"}) by (pod) / clamp_min(sum(rate(s2t_cgroup_cpu_periods_total[2m]) * on(uid) group_left(pod) kube_pod_info{namespace="'+N+'"}) by (pod), 0.000001)','percentunit','{{pod}}'))
pair(('Pod CPU requests','sum(kube_pod_container_resource_requests{resource="cpu"}) by (pod)','short','{{pod}}'),('PVC 請求容量','kube_persistentvolumeclaim_resource_requests_storage_bytes','bytes','{{persistentvolumeclaim}}'))
dashboard={'uid':'s2t-overview','title':'S2T · 一張總覽 / 首字延遲與服務健康','schemaVersion':41,'version':1,'timezone':'browser','refresh':'5s','time':{'from':'now-15m','to':'now'},'tags':['S2T','isolated-mock'],'panels':panels,'editable':False}
Path(__file__).with_name('dashboard.json').write_text(json.dumps(dashboard,ensure_ascii=False,indent=2)+'\n')
cm('s2t-dashboard',{'dashboard.json':json.dumps(dashboard,ensure_ascii=False)})
deploy('grafana','grafana/grafana:12.2.0',3000,env=[secretEnv('GF_SECURITY_ADMIN_PASSWORD','grafana-password'),{'name':'GF_USERS_ALLOW_SIGN_UP','value':'false'},{'name':'GF_AUTH_ANONYMOUS_ENABLED','value':'true'},{'name':'GF_AUTH_ANONYMOUS_ORG_ROLE','value':'Viewer'},{'name':'GF_ANALYTICS_REPORTING_ENABLED','value':'false'},{'name':'GF_ANALYTICS_CHECK_FOR_UPDATES','value':'false'},{'name':'GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH','value':'/var/lib/grafana/dashboards/dashboard.json'}],volumes=[{'name':'data','persistentVolumeClaim':{'claimName':'grafana-data'}},{'name':'provisioning','configMap':{'name':'grafana-provisioning'}},{'name':'dashboards','configMap':{'name':'s2t-dashboard'}}],mounts=[{'name':'data','mountPath':'/var/lib/grafana'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/datasources/datasources.yaml','subPath':'datasources.yaml'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/dashboards/dashboards.yaml','subPath':'dashboards.yaml'},{'name':'dashboards','mountPath':'/var/lib/grafana/dashboards'}],cpu='100m',mem='128Mi')
items[-2]['spec']['template']['spec']['securityContext']={'fsGroup':472,'runAsUser':472}
Path(__file__).with_name('stack.json').write_text(json.dumps({'apiVersion':'v1','kind':'List','items':items},indent=2)+'\n')
