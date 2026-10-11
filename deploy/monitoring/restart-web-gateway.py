#!/usr/bin/env python3
"""Apply the already-built monitoring image using the existing Compose env/volumes."""
import os, subprocess, urllib.request, re, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
for attempt in range(10):
    with urllib.request.urlopen('http://127.0.0.1:8787/metrics',timeout=5) as response:
        text=response.read().decode()
    current=re.search(r'^s2t_gateway_inflight_requests (\d+)$',text,re.M)
    # The metrics scrape itself is included in this gauge.
    if current and int(current.group(1))<=1:break
    time.sleep(2)
else:raise SystemExit('Gateway still has active requests; retry when idle.')
environment=dict(os.environ)
# Compose interpolates build args even with --no-build. No registry is used here.
environment.setdefault('NPM_REGISTRY','https://build-disabled.invalid')
subprocess.run(['docker-compose','-p','s2t-gateway','-f','docker-compose.gateway.yml','-f','deploy/monitoring/gateway-override.yml','up','-d','--no-build','--no-deps','gateway'],cwd=ROOT,env=environment,check=True)
for attempt in range(60):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8787/readyz',timeout=3) as response:
            if response.status==200:print('8787 gateway ready with monitoring image; existing env and data volumes preserved.');break
    except Exception:pass
    time.sleep(1)
else:raise SystemExit('Gateway readiness did not recover; inspect container logs.')
