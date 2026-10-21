#!/usr/bin/env python3
"""Collect all four load shards; compute percentiles from actual combined samples."""
import concurrent.futures, gzip, json, math, subprocess, sys
from pathlib import Path
K=['/opt/homebrew/bin/kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
base=sys.argv[1] if len(sys.argv)>1 else 'performance-load-smoke'
out=Path(sys.argv[2] if len(sys.argv)>2 else '/tmp/s2t-k8s-report.json')
def read(index):
    raw=subprocess.check_output(K+['exec','deployment/'+base+'-'+str(index),'--','node','-e','fetch("http://127.0.0.1:9095/raw-report").then(r=>r.text()).then(console.log)'],text=True)
    report=json.loads(raw)
    report.setdefault('startedAt', None)
    return report
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor: shards=list(executor.map(read,range(4)))
def summarize(values):
    durations=sorted(v for value in values for v in value['durations'])
    residuals=sorted(v for value in values for v in value['residuals'])
    def q(a,p):return a[min(len(a)-1,math.ceil(len(a)*p)-1)] if a else None
    attempted=sum(x['attempted'] for x in values); errors=sum(x['errors'] for x in values)
    statuses={}; error_types={}
    for x in values:
        for key,value in x['statuses'].items():statuses[key]=statuses.get(key,0)+value
        for key,value in x['errorTypes'].items():error_types[key]=error_types.get(key,0)+value
    return dict(attempted=attempted,errors=errors,successRate=(attempted-errors)/attempted if attempted else None,statuses=statuses,errorTypes=error_types,p50Ms=q(durations,.5),p90Ms=q(durations,.9),p95Ms=q(durations,.95),p99Ms=q(durations,.99),maxMs=durations[-1] if durations else None,over3s=sum(x['over3s'] for x in values),residualP95Ms=q(residuals,.95))
stages={key:summarize([x['rawStages'][key] for x in shards]) for key in shards[0]['rawStages']}
minutes=[]
for minute in sorted(set(m for x in shards for m,_ in x['rawMinutes'])):
    data=[value for x in shards for m,value in x['rawMinutes'] if m==minute]
    minutes.append({'minute':minute,'stages':{key:summarize([x[key] for x in data]) for key in stages}})
offered=sum(x['offered'] for x in shards); dropped=sum(x['dropped'] for x in shards)
http=[x for key,x in stages.items() if key!='chain']; http_attempts=sum(x['attempted'] for x in http); http_errors=sum(x['errors'] for x in http)
result=dict(users=sum(x['users'] for x in shards),gatewayReplicas=shards[0]['gatewayReplicas'],durationSeconds=shards[0]['durationSeconds'],finished=all(x['finished'] for x in shards),startedAt=[x['startedAt'] for x in shards],warmup=[x.get('warmup') for x in shards],offered=offered,dropped=dropped,offeredSuccessRate=(stages['chain']['attempted']-stages['chain']['errors'])/offered if offered else None,httpAttempts=http_attempts,httpErrors=http_errors,httpSuccessRate=(http_attempts-http_errors)/http_attempts if http_attempts else None,stages=stages,minutes=minutes,generatorLoopP99Ms=[x['generatorLoopP99Ms'] for x in shards],generatorLoopMaxMs=[x['generatorLoopMaxMs'] for x in shards],note=shards[0]['note'])
failures={}
for shard in shards:
    for message,count in shard['failures'].items():failures[message]=failures.get(message,0)+count
result['failures']=failures
deployment=json.loads(subprocess.check_output(K+['get','deployment','gateway','-o','json'],text=True))
container=deployment['spec']['template']['spec']['containers'][0]
safe_settings={'S2T_BACKGROUND_MAX_INFLIGHT','S2T_MODEL_HTTP_MAX_CONNECTIONS','NODE_OPTIONS','S2T_POSTGRES_MAX_CONNECTIONS','S2T_POSTGRES_FENCE_SESSIONS','S2T_ASR_MAX_INFLIGHT','S2T_TRANSLATION_MAX_INFLIGHT'}
result['gatewayAtCollection']={'replicas':deployment['spec']['replicas'],'image':container['image'],'resources':container.get('resources',{}),'settings':{x['name']:x.get('value') for x in container.get('env',[]) if x['name'] in safe_settings}}
target_users=shards[0].get('targetUsers',500)
result['targetUsers']=target_users
result['workloadComplete']=result['finished'] and result['users']==target_users and all(x.get('targetUsers',500)==target_users for x in shards) and offered==target_users*math.ceil(result['durationSeconds']*1000/shards[0]['cadenceMs'])
result['strictApiChainPassed'] = result['workloadComplete'] and not dropped and not http_errors and not stages['asr']['over3s'] and not stages['chain']['over3s']
result['p90LatencyPassed'] = all(stages[key]['p90Ms'] is not None and stages[key]['p90Ms']<3000 for key in ('asr','chain'))
result['p90ApiChainPassed'] = result['workloadComplete'] and not dropped and not http_errors and result['p90LatencyPassed']
result['acceptance10mComplete'] = result['workloadComplete'] and result['durationSeconds']==600
result['latencyCriterion'] = {'percentile':90,'thresholdMs':3000,'stages':['asr','chain'],'scope':'HTTP; separately verify synchronized browser E2E including paint','method':'nearest-rank over combined raw samples; no averaging shard quantiles'}
out.parent.mkdir(parents=True,exist_ok=True)
raw_path=out.with_suffix('.raw.json.gz')
with gzip.open(raw_path,'wt',encoding='utf-8') as archive:json.dump(shards,archive,ensure_ascii=False)
result['rawSamplesArchive']=raw_path.name
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({key:value for key,value in result.items() if key not in ('minutes','note')},ensure_ascii=False))
