import subprocess,tempfile,time,pathlib
prefix='s2t-sentinel-check'; names=[]; created=False
def docker(*args): return subprocess.check_output(['docker',*args],text=True).strip()
try:
 docker('network','create',prefix); created=True
 for i in range(3):
  name=f'{prefix}-r{i}'
  args=['run','-d','--name',name,'--network',prefix,'redis:7-alpine','redis-server','--requirepass','redis-test-password','--masterauth','redis-test-password']
  if i: args+=['--replicaof',f'{prefix}-r0','6379']
  docker(*args);names.append(name)
 ip=docker('inspect',f'{prefix}-r0','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 for i in range(3):
  name=f'{prefix}-s{i}'
  config=f'port 26379\nbind 0.0.0.0\nprotected-mode no\nrequirepass sentinel-test-password\nsentinel monitor testmaster {ip} 6379 2\nsentinel auth-pass testmaster redis-test-password\nsentinel sentinel-pass sentinel-test-password\nsentinel down-after-milliseconds testmaster 1500\nsentinel failover-timeout testmaster 10000\n'
  docker('run','-d','--name',name,'--network',prefix,'redis:7-alpine','sh','-c','sleep 3600');names.append(name)
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'sentinel.conf';p.write_text(config);docker('cp',str(p),name+':/tmp/sentinel.conf')
  subprocess.Popen(['docker','exec',name,'redis-server','/tmp/sentinel.conf','--sentinel'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 time.sleep(5)
 docker('stop',f'{prefix}-s0')
 names.append(prefix+'-client')
 result=subprocess.run(['docker','run','--name',prefix+'-client','--rm','--network',prefix,'-v',str(pathlib.Path(__file__).resolve().parents[2])+':/test:ro','-w','/test','s2t-scale-test:web','node','tests/integration/redis-sentinel-integration.cjs'],timeout=90)
 if result.returncode: raise RuntimeError('Sentinel integration failed')
finally:
 for name in names:
  subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if created: subprocess.run(['docker','network','rm',prefix],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
