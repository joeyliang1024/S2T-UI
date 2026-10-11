"""Verify URL precedence, dotenv parsing and rejected URLs without a cluster."""
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deploy/monitoring'))
import connection

with patch.dict(os.environ, {}, clear=True), tempfile.TemporaryDirectory() as tmp:
    # Root can have no .env; defaults remain deterministic.
    with patch.object(connection, 'ROOT', Path(tmp)):
        assert connection.resolve_url() == connection.DEFAULT_URL
    # Exercise dotenv in the actual Node dependency root without touching user .env.
    with patch.object(connection.subprocess, 'check_output', return_value=json.dumps('http://dotenv.test:9090')):
        with patch.object(Path, 'exists', return_value=True):
            assert connection.resolve_url() == 'http://dotenv.test:9090'
            os.environ['PROMETHEUS_URL'] = 'https://override.test/prometheus'
            assert connection.resolve_url() == 'https://override.test/prometheus'
    for value in ['http://user:password@example.test', 'http://example.test:70000',
                  'http://example.test:0', 'http://example.test/#fragment',
                  'http://bad host', 'file:///tmp/x']:
        os.environ['PROMETHEUS_URL'] = value
        try:
            connection.resolve_url()
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid URL accepted')
stack = {'items': [
    {'kind': 'ConfigMap', 'metadata': {'name': 'monitoring-connection'}, 'data': {}},
    {'kind': 'Deployment', 'metadata': {'name': 'grafana'}, 'spec': {'template': {'metadata': {'annotations': {'existing': 'keep'}}}}}
]}
connection.configure_stack(stack, 'http://prometheus:9090')
annotations = stack['items'][1]['spec']['template']['metadata']['annotations']
assert annotations['existing'] == 'keep'
original = annotations['s2t/prometheus-url-sha256']
connection.configure_stack(stack, 'http://prometheus:9090')
assert annotations['s2t/prometheus-url-sha256'] == original
connection.configure_stack(stack, 'http://prometheus:9091')
assert annotations['s2t/prometheus-url-sha256'] != original
print('PASS URL precedence, rejection, annotation preservation and deterministic restart hash')
