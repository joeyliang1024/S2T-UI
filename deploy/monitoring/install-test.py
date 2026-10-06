#!/usr/bin/env python3
import json, subprocess, secrets
from pathlib import Path
K=['kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
def run(args,data=None):return subprocess.check_output(K+args,input=data,text=True)
# Read isolated service credentials without emitting them or placing them in manifests.
redis=json.loads(run(['get','statefulset','redis','-o','json']))
env={e['name']:e.get('value') for e in redis['spec']['template']['spec']['containers'][0]['env']}
private=Path('experiment/monitoring-2026-10-06/private');private.mkdir(parents=True,exist_ok=True)
file=private/'credentials.json'
if file.exists():values=json.loads(file.read_text())
else:
    values={'redis-password':env['REDIS_PASSWORD'],'sentinel-password':env['SENTINEL_PASSWORD'],'grafana-password':secrets.token_urlsafe(24),'postgres-password':secrets.token_urlsafe(24)}
    file.write_text(json.dumps(values));file.chmod(0o600)
password=values['postgres-password']
sql=f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='s2t_monitor') THEN CREATE ROLE s2t_monitor LOGIN PASSWORD '{password}' CONNECTION LIMIT 3; END IF; END $$; GRANT pg_monitor TO s2t_monitor; ALTER ROLE s2t_monitor SET statement_timeout='3000ms';\n"
run(['exec','-i','deploy/postgres','--','psql','-U','s2t','-d','s2t'],sql)
values['postgres-dsn']=f"postgresql://s2t_monitor:{password}@postgres:5432/s2t?sslmode=disable&connect_timeout=3"
secret={'apiVersion':'v1','kind':'Secret','metadata':{'name':'monitoring-credentials','namespace':'s2t-stress-20261005'},'type':'Opaque','stringData':{k:v for k,v in values.items() if k!='postgres-password'}}
run(['apply','-f','-'],json.dumps(secret))
stack=json.loads(Path('deploy/monitoring/stack.json').read_text())
api=json.loads(subprocess.check_output(['kubectl','--context','colima-s2t-stress','-n','default','get','endpointslices','-l','kubernetes.io/service-name=kubernetes','-o','json'],text=True))['items'][0]
for item in stack['items']:
    if item['kind']=='NetworkPolicy':
        item['spec']['egress'][0]['to'][1]['ipBlock']['cidr']=api['endpoints'][0]['addresses'][0]+'/32'
        item['spec']['egress'][0]['ports'][1]['port']=api['ports'][0]['port']
print(run(['apply','-f','-'],json.dumps(stack)))
print(run(['set','env','deployment/minio','MINIO_PROMETHEUS_AUTH_TYPE=public']))
print(run(['rollout','status','deployment/minio','--timeout=60s']))
subprocess.check_call(['python3','deploy/monitoring/rename-app-redis.py'])
