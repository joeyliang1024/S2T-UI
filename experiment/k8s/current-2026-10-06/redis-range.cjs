const fs=require('node:fs')
;(async()=>{
 const load=JSON.parse(fs.readFileSync('/tmp/telemetry-load-failed.json','utf8')),start=Date.parse(load.startedAt)/1000-30,end=start+150
 const query=encodeURIComponent('redis_up{job="redis"}')
 const value=await(await fetch(`http://prometheus:9090/api/v1/query_range?query=${query}&start=${start}&end=${end}&step=5`)).json()
 console.log(JSON.stringify({loadStartedAt:load.startedAt,status:value.status,result:value.data?.result},null,2))
})().catch(e=>{console.error(e);process.exitCode=1})
