#!/usr/bin/env python3
"""Start configurable users and a visible-renderer probe from one synchronized controller."""
import json,os,subprocess,sys
from pathlib import Path
K=['/opt/homebrew/bin/kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
mode='--load' if '--load' in sys.argv else '--smoke'
env={**os.environ,'S2T_PERF_REPLICAS':'2'}
users=int(env.get('S2T_PERF_TOTAL_USERS','500'))
subprocess.run(['python3',str(Path(__file__).with_name('deploy.py')),mode],env=env,check=True)
base='performance-load-'+('10m' if mode=='--load' else 'smoke')
d=json.loads(subprocess.check_output(K+['get','deployment',base+'-0','-o','json']))
settings={x['name']:x.get('value') for x in d['spec']['template']['spec']['containers'][0]['env']}
seconds=settings['S2T_PERF_SECONDS']
report=os.environ.get('S2T_PROBE_REPORT','experiment/evaluation-reports/k8s-performance/2-pod-browser-'+str(users)+'users-'+seconds+'s.json')
env.update({'S2T_BROWSER_EXECUTABLE':os.environ.get('S2T_BROWSER_EXECUTABLE','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),'S2T_PROBE_SECONDS':seconds,'S2T_PROBE_START_AT':settings['S2T_PERF_START_AT'],'S2T_PROBE_REPORT':report})
print(json.dumps({'event':'synchronized_run','gatewayPods':2,'users':users,'backgroundWorkers':int(env.get('S2T_PERF_BACKGROUND_WORKERS','0')),'seconds':int(seconds),'plannedStartEpochMs':settings['S2T_PERF_START_AT'],'browserReport':report}),flush=True)
subprocess.run(['node',str(Path(__file__).with_name('browser-probe.cjs'))],env=env,check=True)
