"""Resolve the Grafana datasource URL without reading service credentials."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_URL = 'http://prometheus:9090'


def gateway_metrics_url():
    """Optional separately scraped Web gateway; environment overrides dotenv."""
    value = os.environ.get('S2T_GATEWAY_METRICS_URL')
    if value is None and (ROOT / '.env').exists():
        value = json.loads(subprocess.check_output(
            ['node', '-e', "const fs=require('fs'),dotenv=require('dotenv');process.stdout.write(JSON.stringify(dotenv.parse(fs.readFileSync('.env')).S2T_GATEWAY_METRICS_URL ?? null))"], cwd=ROOT, text=True))
    return value or ''


def resolve_url():
    value = os.environ.get('PROMETHEUS_URL')
    if value is None and (ROOT / '.env').exists():
        # Match the application's dotenv syntax, including quoted values/comments.
        value = json.loads(subprocess.check_output(
            ['node', '-e', "const fs=require('fs'),dotenv=require('dotenv');process.stdout.write(JSON.stringify(dotenv.parse(fs.readFileSync('.env')).PROMETHEUS_URL ?? null))"],
            cwd=ROOT, text=True))
    value = value or DEFAULT_URL
    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError:
        raise ValueError('Invalid PROMETHEUS_URL port') from None
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.fragment or any(c.isspace() for c in value)
            or (port is not None and port < 1)):
        raise ValueError('PROMETHEUS_URL must be an HTTP(S) URL without credentials, whitespace or fragments')
    return value


def configure_stack(stack, url):
    for item in stack['items']:
        if item['kind'] == 'ConfigMap' and item['metadata']['name'] == 'monitoring-connection':
            item['data']['PROMETHEUS_URL'] = url
        if item['kind'] == 'Deployment' and item['metadata']['name'] == 'grafana':
            annotations = item['spec']['template']['metadata'].setdefault('annotations', {})
            annotations['s2t/prometheus-url-sha256'] = hashlib.sha256(url.encode()).hexdigest()
    return stack
