#!/usr/bin/env python3
"""Move isolated application Pods to the new Redis names, atomically with the new image."""
import json,subprocess
K=['kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
mapping={'S2T_REDIS_SENTINEL_MASTER_NAME':'REDIS_SERVICE_NAME','S2T_REDIS_SENTINEL_NODES':'REDIS_SENTINEL_NODES','S2T_REDIS_SENTINEL_USERNAME':'REDIS_SENTINEL_USERNAME','S2T_REDIS_SENTINEL_PASSWORD':'REDIS_SENTINEL_PASSWARD','S2T_REDIS_PASSWORD':'REDIS_PASSWARD','S2T_REDIS_USERNAME':'REDIS_USERNAME','S2T_REDIS_SENTINEL_TLS':'REDIS_SENTINEL_TLS','S2T_REDIS_TLS':'REDIS_TLS','S2T_REDIS_DATABASE':'REDIS_DATABASE','S2T_REDIS_URL':'REDIS_URL'}
sources = set()
for name in ['gateway','audio-worker']:
 obj=json.loads(subprocess.check_output(K+['get','deployment',name,'-o','json'],text=True))
 for container in obj['spec']['template']['spec']['containers']:
  for source in container.get('envFrom',[]):
   if source.get('prefix'): raise RuntimeError('Prefixed envFrom must be migrated explicitly')
   for kind,ref in [('secret','secretRef'),('configmap','configMapRef')]:
    if ref in source:sources.add((kind,source[ref]['name']))
for kind,name in sources:
 source=json.loads(subprocess.check_output(K+['get',kind,name,'-o','json'],text=True))
 data=source.get('data',{})
 for old,new in mapping.items():
  if old in data:
   if new in data and data[new]!=data[old]:raise RuntimeError('Conflicting Redis setting names in '+name)
   data[new]=data.pop(old)
 patch={'data':{**data,**{old:None for old in mapping}}}
 print(subprocess.check_output(K+['patch',kind,name,'--type=merge','--patch-file=/dev/stdin'],input=json.dumps(patch),text=True))
for name in ['gateway','audio-worker']:

 obj=json.loads(subprocess.check_output(K+['get','deployment',name,'-o','json'],text=True))
 for c in obj['spec']['template']['spec']['containers']:
  for env in c.get('env',[]):env['name']=mapping.get(env['name'],env['name'])
  if c['name']==name:
   c['image']='s2t-stress:20261006-stage-share-v2'
   if not any(e['name']=='REDIS_SENTINEL_USERNAME' for e in c['env']):c['env'].append({'name':'REDIS_SENTINEL_USERNAME','value':'default'})
 patch={'spec':{'template':{'spec':{'containers':obj['spec']['template']['spec']['containers']}}}}
 # Patch content includes credentials and is sent via stdin, never a command argument.
 print(subprocess.check_output(K+['patch','deployment',name,'--type=merge','--patch-file=/dev/stdin'],input=json.dumps(patch),text=True))
