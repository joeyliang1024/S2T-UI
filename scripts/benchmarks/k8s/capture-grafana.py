#!/usr/bin/env python3
"""Preserve actual Grafana datasource measurements for one benchmark window."""
import argparse,concurrent.futures,datetime,json,time,urllib.parse,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--report',required=True);p.add_argument('--output',required=True);args=p.parse_args()
report=json.loads(Path(args.report).read_text())
start=min(datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp() for x in report['startedAt'] if x)
end=min(time.time(),start+report['durationSeconds']+15)
queries={
 'up':'up{job="s2t",metrics_scope=""}',
 'client_errors':'sum by(kind)(rate(s2t_perf_errors_total{instance=~"performance-load-10m.*"}[1m]))',
 'dropped':'sum(s2t_perf_dropped_total{instance=~"performance-load-10m.*"})',
 'pending':'sum(s2t_perf_pending{instance=~"performance-load-10m.*"})',
 'max_shard_p95':'max by(kind)(s2t_perf_duration_milliseconds{instance=~"performance-load-10m.*",quantile="0.95"})',
 'max_shard_p90':'max by(kind)(s2t_perf_duration_milliseconds{instance=~"performance-load-10m.*",quantile="0.9"})',
 'gateway_cpu':'rate(s2t_process_cpu_seconds_total{job="s2t"}[30s])',
 'event_loop':'s2t_event_loop_p99_seconds{job="s2t"}',
 'background_active':'sum(s2t_redis_capacity_state{job="s2t",state="backgroundActive"})',
 'background_waiting':'sum(s2t_redis_capacity_state{job="s2t",state="backgroundWaiting"})',
 'host_pressure':'s2t_host_pressure_ratio{job="s2t"}',
 'host_load':'s2t_host_load_average{job="s2t"}',
 'postgres_pools':'s2t_postgres_connections{job="s2t"}',
 'redis_queues':'s2t_redis_capacity_state{job="s2t"}',
 'minio_pool':'s2t_minio_http_capacity{job="s2t"}',
 'model_http_pool':'s2t_model_http_capacity{job="s2t"}',
 'storage_p95':'histogram_quantile(0.95,sum by(operation,le)(rate(s2t_storage_operation_duration_seconds_bucket{job="s2t"}[1m])))',
 'server_stage_p95':'histogram_quantile(0.95,sum by(stage,le)(rate(s2t_server_stage_duration_seconds_bucket{job="s2t"}[1m])))',
 'renderer_p95':'histogram_quantile(0.95,sum by(stage,le)(rate(s2t_caption_stage_duration_seconds_bucket{job="s2t",stage=~"e2e_asr|e2e_translation|t5_network|t7_network"}[1m])))',
 'renderer_p90':'histogram_quantile(0.90,sum by(stage,le)(rate(s2t_caption_stage_duration_seconds_bucket{job="s2t",stage=~"e2e_asr|e2e_translation|t5_network|t7_network"}[1m])))',
 'memory':'container_memory_working_set_bytes{namespace="s2t-stress-20261005",pod!=""}',
 'redis_memory':'redis_memory_used_bytes',
 'redis_clients':'redis_connected_clients',
}
base='http://127.0.0.1:13000/api/datasources/proxy/uid/s2t-prometheus/api/v1/query_range?'
def read(item):
 name,query=item
 query=query.replace('performance-load-10m.*','performance-load-'+('10m' if report['durationSeconds']==600 else 'smoke')+'.*')
 try:
  data=json.load(urllib.request.urlopen(base+urllib.parse.urlencode(dict(query=query,start=start,end=end,step=5)),timeout=30))
  if data.get('status')!='success':raise RuntimeError(str(data))
  return name,dict(query=query,result=data['data']['result'])
 except Exception as error:return name,dict(query=query,error=str(error))
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:data=dict(pool.map(read,queries.items()))
out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(dict(start=start,end=end,source='Grafana s2t-prometheus datasource; real job=s2t',queries=data),indent=2)+'\n')
print(json.dumps(dict(output=str(out),start=start,end=end,missing=[name for name,value in data.items() if not value.get('result')],note='Acceptance uses P90 from combined raw samples; shard quantiles and histogram estimates are diagnostic only.')))
