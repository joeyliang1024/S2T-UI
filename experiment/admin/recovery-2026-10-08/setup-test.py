import subprocess,json,copy
K=['kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
def get(kind,name):return json.loads(subprocess.check_output(K+['get',kind,name,'-o','json'],text=True))
def apply(obj):subprocess.run(K+['apply','-f','-'],input=json.dumps(obj),text=True,check=True)
# A disposable database; existing s2t database is never cleared.
subprocess.run(K+['exec','deploy/postgres','--','psql','-U','s2t','-d','postgres','-c','CREATE DATABASE s2t_admin_recovery_test'],check=True)
g=get('deployment','gateway');spec=copy.deepcopy(g['spec']);spec['replicas']=2;spec['selector']['matchLabels']={'app':'admin-test-gateway'};spec['template']['metadata']={'labels':{'app':'admin-test-gateway'}}
c=spec['template']['spec']['containers'][0];c['image']='s2t-stress:20261008-admin-release';c['imagePullPolicy']='IfNotPresent'
overrides={'S2T_POSTGRES_DB_NAME':'s2t_admin_recovery_test','S2T_STORAGE_MIGRATIONS':'auto','S2T_BOOTSTRAP_ADMIN_USERNAME':'admin','S2T_BOOTSTRAP_ADMIN_PASSWORD':'admin-test-password-only','S2T_MINIO_BUCKET':'s2t-admin-test','S2T_MILVUS_COLLECTION':'s2t_admin_test_voiceprints','S2T_ASR_ENDPOINT':'http://mock-models:9090/v1','S2T_ASR_MODEL':'mock-asr','S2T_ASR_API_KEY':'isolated-mock-only','S2T_TRANSLATION_ENDPOINT':'http://mock-models:9090/v1','S2T_TRANSLATION_MODEL':'mock-translation','S2T_TRANSLATION_API_KEY':'isolated-mock-only','S2T_POSTGRES_MAX_CONNECTIONS':'4'}
c['env']=[e for e in c.get('env',[]) if e['name'] not in overrides]+[{'name':k,'value':v} for k,v in overrides.items()]
apply({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'admin-test-gateway','namespace':'s2t-stress-20261005'},'spec':spec})
apply({'apiVersion':'v1','kind':'Service','metadata':{'name':'admin-test-gateway','namespace':'s2t-stress-20261005'},'spec':{'selector':{'app':'admin-test-gateway'},'ports':[{'port':8787,'targetPort':8787}]}})
subprocess.run(K+['rollout','status','deployment/admin-test-gateway','--timeout=120s'],check=True)
