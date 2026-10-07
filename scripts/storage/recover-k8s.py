#!/usr/bin/env python3
"""Run a fresh recovery Job using the Gateway's existing environment, then restart it."""
import argparse, json, subprocess, time
parser=argparse.ArgumentParser()
parser.add_argument('--context', required=True)
parser.add_argument('--namespace', required=True)
parser.add_argument('--deployment', default='gateway')
args=parser.parse_args()
k=['kubectl','--context',args.context,'-n',args.namespace]
def run(command):return subprocess.check_output(k+command,text=True)
deployment=json.loads(run(['get','deployment',args.deployment,'-o','json']))
pod=deployment['spec']['template']['spec']
container=next(c for c in pod['containers'] if c['name']=='gateway')
name='s2t-storage-recovery-'+str(time.time_ns())
job={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':name,'namespace':args.namespace},'spec':{'backoffLimit':1,'ttlSecondsAfterFinished':300,'template':{'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'securityContext':pod.get('securityContext',{}),'nodeSelector':pod.get('nodeSelector',{}),'tolerations':pod.get('tolerations',[]),'imagePullSecrets':pod.get('imagePullSecrets',[]),'containers':[{'name':'recovery','securityContext':container.get('securityContext',{}),'image':container['image'],'imagePullPolicy':container.get('imagePullPolicy','IfNotPresent'),'envFrom':container.get('envFrom',[]),'env':container.get('env',[]),'command':['node','scripts/storage/recover-storage.cjs'],'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'memory':'256Mi'}}}]}}}}
subprocess.run(k+['create','-f','-'],input=json.dumps(job),text=True,check=True)
subprocess.run(k+['wait','--for=condition=complete','job/'+name,'--timeout=120s'],check=True)
# Restart only after successful recovery; a previously rejected ready Promise
# remains rejected in existing processes. Workers use the same schema.
subprocess.run(k+['rollout','restart','deployment/'+args.deployment],check=True)
subprocess.run(k+['rollout','status','deployment/'+args.deployment,'--timeout=120s'],check=True)
if args.deployment=='gateway':
    worker=subprocess.run(k+['get','deployment','audio-worker'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if worker.returncode==0:
        subprocess.run(k+['rollout','restart','deployment/audio-worker'],check=True)
        subprocess.run(k+['rollout','status','deployment/audio-worker','--timeout=120s'],check=True)
print('Schema and missing bootstrap admin recovered; existing credentials preserved. Deleted records require backup restoration.')
