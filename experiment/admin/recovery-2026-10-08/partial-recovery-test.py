import json,subprocess,time,urllib.request
from pathlib import Path
K=['kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
ROOT=Path(__file__).resolve().parents[3]
def pods():return [p for p in json.loads(subprocess.check_output(K+['get','pods','-l','app=admin-test-gateway','-o','json'],text=True))['items'] if not p['metadata'].get('deletionTimestamp')]
def login():
 d=json.loads(subprocess.check_output(K+['exec','load-client','--','node','-e',"fetch('http://admin-test-gateway:8787/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin-test-password-only'})}).then(async r=>{const b=await r.json();if(!r.ok)throw Error(r.status);console.log(JSON.stringify({id:b.user.id,role:b.user.role}))})"],text=True));return d
before=login();diagnostics=[]
try:
 # The target is a dedicated disposable database, never the live s2t database.
 subprocess.run(K+['exec','deploy/postgres','--','psql','-U','s2t','-d','s2t_admin_recovery_test','-c','DROP TABLE s2t_config_records'],check=True)
 for p in pods():
  value=json.loads(subprocess.check_output(K+['exec',p['metadata']['name'],'--','node','-e',"fetch('http://127.0.0.1:8787/readyz').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))"],text=True));assert value['status']==503;diagnostics.append(value)
 for attempt in range(20):
  current=pods()
  if len(current)==2 and all(not all(c.get('ready') for c in p['status'].get('containerStatuses',[])) for p in current):break
  time.sleep(2)
 else:raise AssertionError('Both Pods must withdraw readiness for missing schema')
finally:
 subprocess.run(['python3',str(ROOT/'scripts/storage/recover-k8s.py'),'--context','colima-s2t-stress','--namespace','s2t-stress-20261005','--deployment','admin-test-gateway'],check=True)
after=login();assert before==after,'Existing admin ID and password must survive additive recovery'
current=pods();assert len(current)==2 and all(all(c.get('ready') for c in p['status'].get('containerStatuses',[])) for p in current)
Path(__file__).with_name('partial-recovery-results.json').write_text(json.dumps({'before':before,'after':after,'existingAdminPreserved':True,'schemaDiagnostics':diagnostics,'readyPodsAfter':2},indent=2)+'\n')
print('PASS missing table withdraws both Pods; additive recovery preserves admin and restores two Ready Pods')
