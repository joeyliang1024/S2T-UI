import ipaddress,json,subprocess
from pathlib import Path
K=['/opt/homebrew/bin/kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
def read(name):return json.loads(subprocess.check_output(K+['get','configmap',name,'-o','json']))
def patch(name,data):subprocess.run(K+['patch','configmap',name,'--type=merge','-p',json.dumps({'data':data})],check=True,stdout=subprocess.DEVNULL)
# Colima can change its node IP across boots. Preserve the model isolation;
# update only the existing Prometheus-to-control-plane allowlist.
endpoint=json.loads(subprocess.check_output(K+['get','endpoints','kubernetes','-n','default','-o','json']))
policy=json.loads(subprocess.check_output(K+['get','networkpolicy','monitoring-api-access','-o','json']))
allowed=policy['spec']['egress'][0]['to']
for subset in endpoint.get('subsets',[]):
    for item in subset.get('addresses',[]):
        rule={'ipBlock':{'cidr':str(ipaddress.ip_address(item['ip']))+'/32'}}
        if rule not in allowed:allowed.append(rule)
subprocess.run(K+['patch','networkpolicy','monitoring-api-access','--type=merge','-p',json.dumps({'spec':{'egress':policy['spec']['egress']}})],check=True,stdout=subprocess.DEVNULL)
p=read('prometheus-config');config=p['data']['prometheus.yml']
for job in ('kubelet-cadvisor','kubelet'):
    header='  - job_name: '+job+'\n'
    if header+'    scrape_interval:' not in config:
        config=config.replace(header,header+'    scrape_interval: 30s\n')
if 'job_name: s2t-user-usage' not in config:
    begin=config.index('  - job_name: s2t\n');end=config.index('  - job_name:',begin+4)
    gateway=config[begin:end]
    runtime=gateway.replace('  - job_name: s2t\n','  - job_name: s2t\n    metrics_path: /metrics/runtime\n')
    usage=gateway.replace('  - job_name: s2t\n','  - job_name: s2t-user-usage\n    scrape_interval: 15s\n    metrics_path: /metrics/users\n')
    usage+='      - {target_label: job, replacement: s2t}\n      - {target_label: metrics_scope, replacement: users}\n'
    config=config[:begin]+runtime+usage+config[end:]
config=config.replace("['redis-0.redis:6379', 'redis-1.redis:6379', 'redis-2.redis:6379']", "['redis:6379', 'redis-replica:6379']").replace("['sentinel-0.sentinel:26379', 'sentinel-1.sentinel:26379', 'sentinel-2.sentinel:26379']", "['sentinel:26379']")
if 'job_name: performance-load' not in config:config+='  - job_name: performance-load\n    static_configs: [{targets: ["performance-load-smoke:9095", "performance-load-10m:9095"]}]\n'
config=config.replace('"performance-load-smoke:9095", "performance-load-10m:9095"', ', '.join('"performance-load-'+kind+'-'+str(i)+':9095"' for kind in ['smoke','10m'] for i in range(4)))
patch('prometheus-config',{'prometheus.yml':config})
patch('s2t-dashboard',{'performance.json':Path('deploy/monitoring/performance-dashboard.json').read_text()})
print('Configured local test Prometheus targets and additive performance dashboard; existing dashboard data preserved.')
