#!/usr/bin/env python3
"""Deploy only to the explicitly isolated local performance namespace.
Never clears volumes or databases. Test service data uses fresh emptyDir volumes.
"""
import json, secrets, subprocess, os, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
NS = 's2t-stress-20261005'
K = ['/opt/homebrew/bin/kubectl', '--context', 'colima-s2t-stress', '-n', NS]
items = []
total_users = int(os.environ.get('S2T_PERF_TOTAL_USERS', '500'))
if not 4 <= total_users <= 500: raise ValueError('Test supports 4..500 total users across four shards')
def add(kind, name, **fields):
    obj = {'apiVersion': 'apps/v1' if kind in ('Deployment', 'StatefulSet') else 'batch/v1' if kind == 'Job' else 'v1', 'kind': kind, 'metadata': {'name': name, 'namespace': NS}, **fields}
    items.append(obj); return obj
def service(name, port, headless=False):
    return add('Service', name, spec={'selector': {'app': name}, 'ports': [{'port': port, 'targetPort': port}], **({'clusterIP': 'None'} if headless else {})})
def env(key, value): return {'name': key, 'value': str(value)}
def secret_env(key, field): return {'name': key, 'valueFrom': {'secretKeyRef': {'name': 'performance-credentials', 'key': field}}}
def deployment(name, image, port, command=None, environment=None, volumes=None, mounts=None, memory='512Mi'):
    container = {'name': name, 'image': image, 'ports': [{'containerPort': port}], 'resources': {'requests': {'cpu': '100m', 'memory': '64Mi'}, 'limits': {'memory': memory}}}
    if command: container['command'] = command
    if environment: container['env'] = environment
    if mounts: container['volumeMounts'] = mounts
    return add('Deployment', name, spec={'replicas': 1, 'selector': {'matchLabels': {'app': name}}, 'template': {'metadata': {'labels': {'app': name}}, 'spec': {'containers': [container], 'volumes': volumes or []}}})
def cm_volume(name): return {'name': name, 'configMap': {'name': name}}
def mount(name, path): return {'name': name, 'mountPath': path, 'readOnly': True}
# Reuse test credentials on subsequent deploys without disclosing or rotating them.
probe = subprocess.run(K + ['get', 'secret', 'performance-credentials', '-o', 'name'], capture_output=True, text=True)
if probe.returncode:
    values = {key: secrets.token_urlsafe(24) for key in ('postgres', 'redis', 'sentinel', 'minio', 'auth')}
    values['postgres-dsn'] = f"postgresql://s2t:{values['postgres']}@postgres:5432/s2t?sslmode=disable&connect_timeout=3"
    add('Secret', 'performance-credentials', type='Opaque', stringData=values)
add('ConfigMap', 'performance-code', data={p.name: p.read_text() for p in Path(__file__).parent.glob('*.cjs')})
service('postgres', 5432)
pg = deployment('postgres', 'postgres:16-alpine', 5432, environment=[env('POSTGRES_DB', 's2t'), env('POSTGRES_USER', 's2t'), secret_env('POSTGRES_PASSWORD', 'postgres')], volumes=[{'name': 'data', 'emptyDir': {}}], mounts=[{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}])
pg['spec']['template']['spec']['containers'][0]['args'] = ['-c', 'max_connections=64', '-c', 'shared_buffers=128MB']
pg['spec']['template']['spec']['containers'][0]['readinessProbe'] = {'exec': {'command': ['pg_isready', '-U', 's2t']}, 'periodSeconds': 2}
service('redis', 6379, True)
redis = deployment('redis', 'redis:7-alpine', 6379, command=['sh', '-c', 'exec redis-server --bind 0.0.0.0 --requirepass "$REDIS_PASSWORD" --masterauth "$REDIS_PASSWORD" --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction'], environment=[secret_env('REDIS_PASSWORD', 'redis')])
service('redis-replica', 6379, True)
replica = deployment('redis-replica', 'redis:7-alpine', 6379, command=['sh', '-c', 'exec redis-server --bind 0.0.0.0 --requirepass "$REDIS_PASSWORD" --masterauth "$REDIS_PASSWORD" --replicaof redis 6379 --maxmemory 256mb --maxmemory-policy noeviction'], environment=[secret_env('REDIS_PASSWORD', 'redis')])
replica['spec']['replicas'] = 2
# Three independent Sentinel processes, backed by a real Redis primary.
service('sentinel', 26379, True)
sentinel_command = '''printf 'port 26379\nbind 0.0.0.0\nprotected-mode no\nrequirepass %s\nsentinel resolve-hostnames yes\nsentinel announce-hostnames yes\nsentinel monitor s2tmaster redis 6379 2\nsentinel auth-pass s2tmaster %s\nsentinel down-after-milliseconds s2tmaster 3000\nsentinel failover-timeout s2tmaster 10000\n' "$SENTINEL_PASSWORD" "$REDIS_PASSWORD" > /tmp/sentinel.conf
exec redis-server /tmp/sentinel.conf --sentinel'''
sent = deployment('sentinel', 'redis:7-alpine', 26379, command=['sh', '-c', sentinel_command], environment=[secret_env('REDIS_PASSWORD', 'redis'), secret_env('SENTINEL_PASSWORD', 'sentinel')])
sent['spec']['replicas'] = 3
service('minio', 9000)
mini = deployment('minio', 'cgr.dev/chainguard/minio:latest', 9000, command=['minio', 'server', '/data'], environment=[env('MINIO_ROOT_USER', 'performance'), secret_env('MINIO_ROOT_PASSWORD', 'minio'), env('MINIO_PROMETHEUS_AUTH_TYPE', 'public')], volumes=[{'name': 'data', 'emptyDir': {}}], mounts=[{'name': 'data', 'mountPath': '/data'}], memory='1536Mi')
mini['spec']['template']['spec']['securityContext'] = {'fsGroup': 65532}
# Repeated benchmark setup must preserve a previously migrated test data disk.
existing_minio = subprocess.run(K + ['get','deployment','minio','-o','json'], capture_output=True, text=True)
if existing_minio.returncode == 0:
    previous = json.loads(existing_minio.stdout)
    volumes = previous['spec']['template']['spec'].get('volumes', [])
    if any(v.get('hostPath', {}).get('path') == '/mnt/lima-colima-s2t-stress/s2t-performance-minio' for v in volumes):
        mini['spec']['template']['spec']['volumes'] = volumes
        mini['spec']['strategy'] = {'type': 'Recreate'}

service('mock-models', 9090)
deployment('mock-models', 'node:22-alpine', 9090, command=['node', '/perf/mock-model.cjs'], volumes=[cm_volume('performance-code')], mounts=[mount('performance-code', '/perf')])
service('postgres-exporter', 9187)
deployment('postgres-exporter', 'quay.io/prometheuscommunity/postgres-exporter:v0.17.1', 9187, environment=[secret_env('DATA_SOURCE_NAME', 'postgres-dsn')])
for name, password in [('redis-exporter', 'redis'), ('sentinel-exporter', 'sentinel')]:
    service(name, 9121)
    dep = deployment(name, 'oliver006/redis_exporter:v1.88.0', 9121, environment=[secret_env('REDIS_PASSWORD', password)])
    dep['spec']['template']['spec']['containers'][0]['args'] = ['--redis.addr=']
# Real Gateway image is rolled out separately once the final build is ready.
subprocess.run(K + ['apply', '-f', '-'], input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}), text=True, check=True)
# Explicit second step: after the final image exists, deploy one Gateway pod.
import sys
if '--gateway' in sys.argv:
    items.clear()
    runtime = {
        'S2T_KUBERNETES_MODE': 'true', 'S2T_PROCESS_ROLE': 'api', 'S2T_WEB_PORT': '8787',
        'S2T_POSTGRES_HOST': 'postgres', 'S2T_POSTGRES_PORT': '5432', 'S2T_POSTGRES_DB_NAME': 's2t', 'S2T_POSTGRES_USER': 's2t', 'S2T_POSTGRES_MAX_CONNECTIONS': '12',
        'S2T_MINIO_ENDPOINT': 'http://minio:9000', 'S2T_MINIO_BUCKET': 'performance', 'S2T_MINIO_ACCESS_KEY': 'performance',
        'REDIS_SENTINEL_NODES': 'sentinel:26379', 'REDIS_SERVICE_NAME': 's2tmaster', 'REDIS_MASTER_POOL_SIZE': '4',
        'S2T_BACKGROUND_MAX_INFLIGHT': '8', 'S2T_ASR_MAX_INFLIGHT': '512', 'S2T_TRANSLATION_MAX_INFLIGHT': '512', 'S2T_MODEL_HTTP_MAX_CONNECTIONS': '512',
        'S2T_ASR_ENDPOINT': 'http://mock-models:9090/v1', 'S2T_ASR_MODEL': 'performance', 'S2T_ASR_API_KEY': 'test-only',
        'S2T_SUMMARY_ENDPOINT': 'http://mock-models:9090/v1', 'S2T_SUMMARY_MODEL': 'performance', 'S2T_SUMMARY_API_KEY': 'test-only',
        'S2T_TRANSLATION_ENDPOINT': 'http://mock-models:9090/v1', 'S2T_TRANSLATION_MODEL': 'performance', 'S2T_TRANSLATION_API_KEY': 'test-only',
        'S2T_AUDIO_SERVICE_URL': 'http://mock-models:9090', 'S2T_AUDIO_SERVICE_TOKEN': 'performance-internal-only',
        'S2T_BOOTSTRAP_ADMIN_USERNAME': 'performance-admin', 'S2T_BOOTSTRAP_ADMIN_PASSWORD': 'performance-only-admin',
        'S2T_LOG_LEVEL': 'warn', 'S2T_LOG_FORMAT': 'json', 'S2T_DATA_DIR': '/tmp/performance-data'
    }
    if os.environ.get('S2T_PERF_NODE_OPTIONS'):
        runtime['NODE_OPTIONS'] = os.environ['S2T_PERF_NODE_OPTIONS']
    environment = [env(key, value) for key, value in runtime.items()] + [secret_env(key, value) for key, value in {
        'S2T_POSTGRES_PASSWORD': 'postgres', 'S2T_MINIO_SECRET_KEY': 'minio', 'REDIS_PASSWARD': 'redis', 'REDIS_SENTINEL_PASSWARD': 'sentinel', 'S2T_AUTH_SECRET': 'auth'
    }.items()]
    service('gateway', 8787)
    gate = deployment('gateway', 's2t-ui:performance-final-20261021', 8787, environment=environment, memory='1536Mi')
    gate['spec']['replicas'] = int(os.environ.get('S2T_PERF_REPLICAS', '2'))
    if not 1 <= gate['spec']['replicas'] <= 3: raise ValueError('Test PG connection budget supports 1..3 Gateway pods')
    gate['spec']['template']['spec']['containers'][0]['imagePullPolicy'] = 'Never'
    gate['spec']['template']['spec']['containers'][0]['resources']['requests']['cpu'] = '1000m'
    gate['spec']['template']['spec']['containers'][0]['readinessProbe'] = {'httpGet': {'path': '/readyz', 'port': 8787}, 'periodSeconds': 3, 'timeoutSeconds': 2}
    gate['spec']['template']['spec']['terminationGracePeriodSeconds'] = 60
    subprocess.run(K + ['apply', '-f', '-'], input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}), text=True, check=True)
if '--load' in sys.argv or '--smoke' in sys.argv:
    items.clear()
    duration = os.environ.get('S2T_PERF_SMOKE_SECONDS', '60') if '--smoke' in sys.argv else '600'
    if not 1 <= int(duration) <= 600: raise ValueError('Invalid test duration')
    base_name = 'performance-load-' + ('smoke' if '--smoke' in sys.argv else '10m')
    start_at = int(time.time() * 1000) + 20000
    for shard in range(4):
        name = base_name + '-' + str(shard)
        service(name, 9095)
        shard_users = total_users // 4 + (1 if shard < total_users % 4 else 0)
        runner = deployment(name, 's2t-ui:performance-final-20261021', 9095, command=['node', '/perf/load.cjs'], environment=[env('NODE_PATH', '/app/node_modules'), env('S2T_PERF_SECONDS', duration), env('S2T_PERF_USERS', shard_users), env('S2T_PERF_TOTAL_USERS', total_users), env('S2T_PERF_START_AT', start_at), env('S2T_PERF_GATEWAY_REPLICAS', os.environ.get('S2T_PERF_REPLICAS', '2')), secret_env('PG_TEST_PASSWORD', 'postgres'), secret_env('PERF_AUTH_SECRET', 'auth')], volumes=[cm_volume('performance-code')], mounts=[mount('performance-code', '/perf')], memory='768Mi')
        runner['spec']['strategy'] = {'type': 'Recreate'}
        runner['spec']['template']['spec']['terminationGracePeriodSeconds'] = 10
        runner['spec']['template']['spec']['containers'][0]['imagePullPolicy'] = 'Never'
        runner['spec']['template']['spec']['containers'][0]['resources']['requests']['cpu'] = '250m'
    subprocess.run(K + ['apply', '-f', '-'], input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}), text=True, check=True)

    background_workers=int(os.environ.get('S2T_PERF_BACKGROUND_WORKERS','0'))
    if not 0 <= background_workers <= 64:raise ValueError('Background workers must be 0..64')
    if background_workers:
        items.clear()
        service('performance-background',9096)
        bg=deployment('performance-background','s2t-ui:performance-final-20261021',9096,command=['node','/perf/background-load.cjs'],environment=[env('NODE_PATH','/app/node_modules'),env('S2T_PERF_START_AT',start_at),env('S2T_PERF_SECONDS',duration),env('S2T_PERF_BACKGROUND_WORKERS',background_workers),secret_env('PG_TEST_PASSWORD','postgres'),secret_env('PERF_AUTH_SECRET','auth')],volumes=[cm_volume('performance-code')],mounts=[mount('performance-code','/perf')],memory='512Mi')
        bg['spec']['strategy']={'type':'Recreate'}
        bg['spec']['template']['spec']['containers'][0]['imagePullPolicy']='Never'
        subprocess.run(K+['apply','-f','-'],input=json.dumps({'apiVersion':'v1','kind':'List','items':items}),text=True,check=True)
