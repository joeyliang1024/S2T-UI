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
# The tracked dashboard is the authoritative, reviewable source for provisioning.
dashboard = json.loads(Path(__file__).with_name('dashboard.json').read_text())
from oncall import build_oncall
oncall = build_oncall(dashboard)
Path(__file__).with_name('oncall.json').write_text(json.dumps(oncall,ensure_ascii=False,indent=2)+'\n')
cm('s2t-dashboard',{'dashboard.json':json.dumps(dashboard,ensure_ascii=False),'oncall.json':json.dumps(oncall,ensure_ascii=False)})
deploy('grafana','grafana/grafana:12.2.0',3000,env=[{'name':'PROMETHEUS_URL','valueFrom':{'configMapKeyRef':{'name':'monitoring-connection','key':'PROMETHEUS_URL'}}},secretEnv('GF_SECURITY_ADMIN_PASSWORD','grafana-password'),{'name':'GF_USERS_ALLOW_SIGN_UP','value':'false'},{'name':'GF_AUTH_ANONYMOUS_ENABLED','value':'true'},{'name':'GF_AUTH_ANONYMOUS_ORG_ROLE','value':'Viewer'},{'name':'GF_ANALYTICS_REPORTING_ENABLED','value':'false'},{'name':'GF_ANALYTICS_CHECK_FOR_UPDATES','value':'false'},{'name':'GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH','value':'/var/lib/grafana/dashboards/dashboard.json'}],volumes=[{'name':'data','persistentVolumeClaim':{'claimName':'grafana-data'}},{'name':'provisioning','configMap':{'name':'grafana-provisioning'}},{'name':'dashboards','configMap':{'name':'s2t-dashboard'}}],mounts=[{'name':'data','mountPath':'/var/lib/grafana'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/datasources/datasources.yaml','subPath':'datasources.yaml'},{'name':'provisioning','mountPath':'/etc/grafana/provisioning/dashboards/dashboards.yaml','subPath':'dashboards.yaml'},{'name':'dashboards','mountPath':'/var/lib/grafana/dashboards'}],cpu='100m',mem='128Mi')
items[-2]['spec']['template']['spec']['securityContext']={'fsGroup':472,'runAsUser':472}
Path(__file__).with_name('stack.json').write_text(json.dumps({'apiVersion':'v1','kind':'List','items':items},indent=2)+'\n')
