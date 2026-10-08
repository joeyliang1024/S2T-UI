#!/usr/bin/env python3
"""Patch only the isolated Redis/Sentinel test resources; keep authenticated PING."""
import json,subprocess
from pathlib import Path
K=['kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
changes=[]
for name in ['redis','sentinel']:
 obj=json.loads(subprocess.check_output(K+['get','statefulset',name,'-o','json'],text=True))
 container=obj['spec']['template']['spec']['containers'][0]
 command=container['readinessProbe']['exec']
 patchContainer={'name':container['name'],'readinessProbe':{'exec':command,'timeoutSeconds':3,'periodSeconds':5,'failureThreshold':3},'startupProbe':{'exec':command,'timeoutSeconds':3,'periodSeconds':3,'failureThreshold':60}}
 if name=='redis':patchContainer['livenessProbe']={'exec':command,'timeoutSeconds':3,'periodSeconds':10,'failureThreshold':6}
 patch={'spec':{'template':{'spec':{'containers':[patchContainer]}}}}
 changes.append({'name':name,'patch':patch})
 print(subprocess.check_output(K+['patch','statefulset',name,'--type=strategic','--patch-file=/dev/stdin'],input=json.dumps(patch),text=True))
Path('experiment/k8s/current-2026-10-06/probe-patches.json').write_text(json.dumps(changes,indent=2)+'\n')
