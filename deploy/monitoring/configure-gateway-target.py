#!/usr/bin/env python3
"""Update only the Web scrape target, its narrow egress rule and dashboard."""
import json
from pathlib import Path
import subprocess
from connection import gateway_metrics_url

if not gateway_metrics_url():
    raise SystemExit('Set S2T_GATEWAY_METRICS_URL in the environment or .env first')
subprocess.run(['python3', str(Path(__file__).with_name('generate.py'))], check=True)
stack = json.loads(Path(__file__).with_name('stack.json').read_text())
selected = [item for item in stack['items'] if item['metadata']['name'] in ('prometheus-config', 's2t-dashboard', 'monitoring-web-gateway')]
kubectl = ['kubectl', '--context', 'colima-s2t-stress', '-n', 's2t-stress-20261005']
subprocess.run(kubectl + ['apply', '-f', '-'], input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': selected}), text=True, check=True)
subprocess.run(kubectl + ['rollout', 'restart', 'deployment/prometheus'], check=True)
subprocess.run(kubectl + ['rollout', 'status', 'deployment/prometheus', '--timeout=120s'], check=True)
