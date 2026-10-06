#!/usr/bin/env python3
"""Install only the named isolated Colima test environment; preserve existing Secrets/PVCs."""
import base64,json,secrets,subprocess
from pathlib import Path
CTX='colima-s2t-stress';NS='s2t-stress-20261005';K=['kubectl','--context',CTX,'-n',NS]
def run(args,value=None):return subprocess.check_output(K+args,input=value,text=True)
def exists(kind,name):return subprocess.run(K+['get',kind,name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
def apply(value):print(run(['apply','-f','-'],json.dumps(value)))
def secret(name,values):
 if exists('secret',name):return
 apply({'apiVersion':'v1','kind':'Secret','metadata':{'name':name,'namespace':NS},'type':'Opaque','stringData':values})
apply({'apiVersion':'v1','kind':'Namespace','metadata':{'name':NS}})
# Transfer existing isolated service credentials when present; never print their values.
serviceValues={}
for kind,name in [('deployment','postgres'),('deployment','minio'),('statefulset','redis')]:
 if not exists(kind,name):continue
 obj=json.loads(run(['get',kind,name,'-o','json']))
 for env in obj['spec']['template']['spec']['containers'][0].get('env',[]):
  if env['name'] not in ['POSTGRES_PASSWORD','MINIO_ROOT_PASSWORD','REDIS_PASSWORD','SENTINEL_PASSWORD']:continue
  if 'value' in env:serviceValues[env['name']]=env['value']
  elif 'secretKeyRef' in env.get('valueFrom',{}):
   ref=env['valueFrom']['secretKeyRef'];data=json.loads(run(['get','secret',ref['name'],'-o','json']))['data'];serviceValues[env['name']]=base64.b64decode(data[ref['key']]).decode()
for name in ['POSTGRES_PASSWORD','MINIO_ROOT_PASSWORD','REDIS_PASSWORD','SENTINEL_PASSWORD']:serviceValues.setdefault(name,secrets.token_urlsafe(24))
secret('s2t-test-services',serviceValues)
serviceData=json.loads(run(['get','secret','s2t-test-services','-o','json']))['data'];serviceValues={k:base64.b64decode(v).decode() for k,v in serviceData.items()}
app={
'S2T_KUBERNETES_MODE':'true','S2T_AUTH_SECRET':secrets.token_urlsafe(48),'S2T_BOOTSTRAP_ADMIN_USERNAME':'admin','S2T_BOOTSTRAP_ADMIN_PASSWORD':secrets.token_urlsafe(24),
'S2T_MINIO_ENDPOINT':'http://minio:9000','S2T_MINIO_ACCESS_KEY':'stress-minio','S2T_MINIO_SECRET_KEY':serviceValues['MINIO_ROOT_PASSWORD'],'S2T_MINIO_BUCKET':'s2t-stress-audio',
'S2T_POSTGRES_HOST':'postgres','S2T_POSTGRES_PORT':'5432','S2T_POSTGRES_DB_NAME':'s2t','S2T_POSTGRES_USER':'s2t','S2T_POSTGRES_PASSWORD':serviceValues['POSTGRES_PASSWORD'],'S2T_POSTGRES_MAX_CONNECTIONS':'8',
'S2T_MILVUS_ENDPOINT':'http://milvus:19530','S2T_MILVUS_DB_NAME':'default','S2T_MILVUS_TOKEN':'isolated-test-only','S2T_MILVUS_COLLECTION':'s2t_stress_voiceprints',
'REDIS_SENTINEL_NODES':','.join(f'sentinel-{i}.sentinel:26379' for i in range(3)),'REDIS_SERVICE_NAME':'s2t-stress-master','REDIS_SENTINEL_USERNAME':'default','REDIS_PASSWARD':serviceValues['REDIS_PASSWORD'],'REDIS_SENTINEL_PASSWARD':serviceValues['SENTINEL_PASSWORD'],
'S2T_ASR_ENDPOINT':'http://mock-models:9090/v1','S2T_ASR_MODEL':'mock-asr','S2T_ASR_API_KEY':'isolated-mock-only','S2T_TRANSLATION_ENDPOINT':'http://mock-models:9090/v1','S2T_TRANSLATION_MODEL':'mock-translation','S2T_TRANSLATION_API_KEY':'isolated-mock-only',
'S2T_DIARIZATION_ENDPOINT':'http://mock-models:9090/diarizations','S2T_DIARIZATION_MODEL':'mock-diarization','S2T_AUDIO_SERVICE_URL':'http://mock-models:9090','S2T_AUDIO_SERVICE_TOKEN':secrets.token_urlsafe(24),
'S2T_ASR_MAX_INFLIGHT':'64','S2T_TRANSLATION_MAX_INFLIGHT':'64','S2T_STORAGE_MIGRATIONS':'verify','S2T_WEB_ORIGINS':'http://127.0.0.1:8790,http://localhost:8790'}
secret('s2t-stress-config',app)
core=json.loads(Path('deploy/test/core.json').read_text())
# Start real Storage first; application images must already exist in this Docker context.
storage=[i for i in core['items'] if i['metadata']['name'] not in ['gateway','audio-worker']]
apply({'apiVersion':'v1','kind':'List','items':storage})
for kind,name in [('deployment','postgres'),('deployment','minio'),('deployment','etcd'),('deployment','milvus'),('statefulset','redis'),('statefulset','sentinel')]:print(run(['rollout','status',kind+'/'+name,'--timeout=60s']))
for name,file,key in [('mock-model-code','scripts/testing/mock-models.cjs','mock-services.cjs'),('load-test-code','scripts/testing/load-test.cjs','load-test.cjs')]:apply({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':name,'namespace':NS},'data':{key:Path(file).read_text()}})
fixtures=json.loads(Path('deploy/test/fixtures.json').read_text());apply({'apiVersion':'v1','kind':'List','items':[i for i in fixtures['items'] if i['kind']!='Pod' or not exists('pod',i['metadata']['name'])]})
print(run(['rollout','status','deployment/mock-models','--timeout=60s']))
# Verify schema with an ephemeral named Job, keeping no credentials in the manifest.
if not exists('job','s2t-test-schema-migration'):
 job={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':'s2t-test-schema-migration','namespace':NS},'spec':{'backoffLimit':2,'template':{'spec':{'restartPolicy':'Never','containers':[{'name':'migration','image':'s2t-stress:20261006-telemetry-backpressure','command':['node','scripts/storage/migrate-schema.cjs'],'envFrom':[{'secretRef':{'name':'s2t-stress-config'}}],'env':[{'name':'S2T_STORAGE_MIGRATIONS','value':'auto'}]}]}}}}
 apply(job)
print(run(['wait','--for=condition=complete','job/s2t-test-schema-migration','--timeout=60s']))
apply({'apiVersion':'v1','kind':'List','items':[i for i in core['items'] if i['metadata']['name'] in ['gateway','audio-worker']]})
for name in ['gateway','audio-worker']:print(run(['rollout','status','deployment/'+name,'--timeout=60s']))
# Stable two-Pod browser ingress survives Gateway rollouts.
apply(json.loads(Path('deploy/test/ingress.json').read_text()))
print(run(['rollout','status','deployment/test-ingress','--timeout=60s']))
# Backup only current Secrets, under the ignored canonical private directory.
private=Path('experiment/k8s/private');private.mkdir(parents=True,exist_ok=True)
for name in ['s2t-stress-config','s2t-test-services']:
 value=json.loads(run(['get','secret',name,'-o','json']));value['metadata']={'name':name,'namespace':NS};value.pop('status',None)
 file=private/(name+'.json');file.write_text(json.dumps(value,indent=2)+'\n');file.chmod(0o600)
print('Storage and applications ready. Install monitoring with deploy/monitoring/install-test.py; fixture accounts are separate.')
