#!/usr/bin/env python3
"""Preserve isolated test MinIO on Colima's existing 40GB data disk.
Run with all performance generators stopped. Never touches PostgreSQL data.
"""
import json,subprocess
K=['/opt/homebrew/bin/kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
SSH=['/opt/homebrew/bin/colima','ssh','--profile','s2t-stress','--']
destination='/mnt/lima-colima-s2t-stress/s2t-performance-minio'
def get(kind,name):return json.loads(subprocess.check_output(K+['get',kind]+([name] if name else [])+['-o','json']))
for dep in get('deployments','')['items']:
    if dep['metadata']['name'].startswith('performance-load-') and dep['spec'].get('replicas',0):raise RuntimeError('Stop performance load generators before copying data')
dep=get('deployment','minio')
if any(v.get('hostPath',{}).get('path')==destination for v in dep['spec']['template']['spec']['volumes']):print('MinIO already uses preserved data disk');raise SystemExit(0)
pod=json.loads(subprocess.check_output(K+['get','pods','-l','app=minio','-o','json']))['items'][0]
uid=pod['metadata']['uid']
if not all(c in '0123456789abcdef-' for c in uid):raise RuntimeError('Unexpected Pod UID')
source='/var/lib/kubelet/pods/'+uid+'/volumes/kubernetes.io~empty-dir/data'
subprocess.run(SSH+['sudo','test','-d',source],check=True)
subprocess.run(SSH+['sudo','mkdir','-p',destination],check=True)
subprocess.run(SSH+['sudo','cp','-a',source+'/.',destination+'/'],check=True)
subprocess.run(SSH+['sudo','chown','65532:65532',destination],check=True)
patch={'spec':{'strategy':{'type':'Recreate','rollingUpdate':None},'template':{'spec':{'volumes':[{'name':'data','hostPath':{'path':destination,'type':'Directory'}}]}}}}
subprocess.run(K+['patch','deployment','minio','--type=merge','-p',json.dumps(patch)],check=True)
subprocess.run(K+['rollout','status','deployment/minio','--timeout=60s'],check=True)
print('Preserved test MinIO data copied to existing data disk; PostgreSQL untouched.')
