#!/usr/bin/env python3
"""Project local shared Markdown templates into the isolated test Gateways."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
k = ['kubectl', '--context', 'colima-s2t-stress', '-n', 's2t-stress-20261005']
code = "require('./server/summary-template-files.cjs').loadFileTemplates('data/template').then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1})"
templates = json.loads(subprocess.check_output(['node', '-e', code], cwd=root, text=True))
items = [{'key': 'md-' + hashlib.sha256(t['sourceFile'].encode()).hexdigest()[:16], 'path': t['sourceFile']} for t in templates]
config = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 's2t-summary-templates', 'namespace': 's2t-stress-20261005'}, 'data': {item['key']: template['content'] for item, template in zip(items, templates)}}
subprocess.run(k + ['apply', '-f', '-'], input=json.dumps(config), text=True, check=True)
exists = subprocess.run(k + ['get', 'deployment/gateway'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
if exists:
    pod = {'volumes': [{'name': 'summary-templates', 'configMap': {'name': 's2t-summary-templates', 'items': items}}], 'containers': [{'name': 'gateway', 'env': [{'name': 'S2T_DATA_DIR', 'value': '/data'}], 'volumeMounts': [{'name': 'summary-templates', 'mountPath': '/data/template', 'readOnly': True}]}]}
    subprocess.run(k + ['patch', 'deployment/gateway', '--type=strategic', '-p', json.dumps({'spec': {'template': {'spec': pod}}})], check=True)
print(f'Synced {len(templates)} Markdown templates; credentials and personal account templates were not changed.')
