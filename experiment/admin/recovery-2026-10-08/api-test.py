import json, urllib.request, urllib.error, os
from pathlib import Path
BASE=os.environ.get('S2T_ADMIN_TEST_ORIGIN','http://localhost:8792')
def call(path,body=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=30) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as r:return r.code,json.load(r)
status,admin=call('/api/auth/login',{'username':'admin','password':'admin-test-password-only'});assert status==200 and admin['user']['role']=='admin'
status,normal=call('/api/auth/register',{'username':'normaladminlab','password':'normal-test-password','NT':'normaladminlab','Department':'Lab','role':'admin'})
if status==409: status,normal=call('/api/auth/login',{'username':'normaladminlab','password':'normal-test-password'})
assert status in [200,201] and normal['user']['role']=='user'
assert call('/api/admin/users',token=normal['token'])[0]==403
assert call('/api/admin/users')[0]==401
assert call('/api/admin/users',token=admin['token'])[0]==200
assert call('/api/admin/users',{'username':'forgedadmin','password':'test-password','NT':'forgedadmin','Department':'Lab','role':'admin'},normal['token'])[0]==403
status,created=call('/api/admin/users',{'username':'secondadmin','password':'second-test-password','NT':'secondadmin','Department':'Lab','role':'admin'},admin['token'])
if status==409: status,created=call('/api/auth/login',{'username':'secondadmin','password':'second-test-password'})
assert status in [200,201] and created['user']['role']=='admin'
# Creating an account must not replace the current admin session.
assert call('/api/auth/session',token=admin['token'])[1]['user']['id']==admin['user']['id']
status,settings=call('/api/data/settings',token=admin['token']);assert status==200
params={'minSpeechMs':160,'minSilenceMs':350,'preRollMs':300,'noiseFloorOffsetDb':12,'chunkMinMs':700,'chunkMaxMs':1800,'translationConcurrency':1,'translationSentenceWaitMs':1000,'translationTemperature':.6,'translationAggregationMs':300,'translationThrottledMs':1200}
assert call('/api/data/settings',{'settings':{'adminParameters':params},'version':settings['version']},admin['token'])[0]==200
assert call('/api/data/settings',token=admin['token'])[1]['settings']['adminParameters']==params
assert call('/api/data/settings',{'settings':{'adminParameters':params},'version':0},normal['token'])[0]==403
assert 'adminParameters' not in call('/api/data/settings',token=normal['token'])[1]['settings']
assert call('/api/data/settings',{'settings':{'adminParameters':{'translationConcurrency':500}},'version':settings['version']+1},admin['token'])[0]==400
assert call('/api/translations',{'text':'test','sourceLanguage':'en','targetLanguage':'zh-TW','temperature':.7},normal['token'])[0]==403
assert call('/api/translations',{'text':'test','sourceLanguage':'en','targetLanguage':'zh-TW','temperature':10},admin['token'])[0]==400
assert call('/api/translations',{'text':'test','sourceLanguage':'en','targetLanguage':'zh-TW','temperature':.7},admin['token'])[0]==200
Path(__file__).with_name('api-results.json').write_text(json.dumps({'adminLogin':True,'registerCannotEscalate':True,'anonymousDenied':True,'ordinaryAccountManagementDenied':True,'adminAccountCreation':True,'adminSessionPreserved':True,'adminParameterPersistence':True,'ordinaryParametersDenied':True,'invalidRangesRejected':True,'translationTemperaturePermission':True},indent=2)+'\n')
print('PASS admin/ordinary isolation, account management, per-account parameters and translation bounds')
