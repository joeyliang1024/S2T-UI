#!/usr/bin/env python3
"""Update only Grafana's datasource connection in the isolated test cluster."""
import json
from pathlib import Path
import subprocess
from connection import ROOT, resolve_url, configure_stack

url = resolve_url()  # Validate before any cluster mutation.
stack = configure_stack(json.loads((ROOT / 'deploy/monitoring/stack.json').read_text()), url)
k = ['kubectl', '--context', 'colima-s2t-stress', '-n', 's2t-stress-20261005']
for item in stack['items']:
    if item['kind'] == 'ConfigMap' and item['metadata']['name'] in ('monitoring-connection', 'grafana-provisioning'):
        subprocess.run(k + ['apply', '-f', '-'], input=json.dumps(item), text=True, check=True)
grafana = next(i for i in stack['items'] if i['kind'] == 'Deployment' and i['metadata']['name'] == 'grafana')
container = grafana['spec']['template']['spec']['containers'][0]
env = [e for e in container['env'] if e['name'] == 'PROMETHEUS_URL']
patch = {'spec': {'template': {'metadata': {'annotations': grafana['spec']['template']['metadata']['annotations']}, 'spec': {'containers': [{'name': 'grafana', 'env': env}]}}}}
subprocess.run(k + ['patch', 'deployment', 'grafana', '--type=strategic', '-p', json.dumps(patch)], check=True)
subprocess.run(k + ['rollout', 'status', 'deployment/grafana', '--timeout=120s'], check=True)
