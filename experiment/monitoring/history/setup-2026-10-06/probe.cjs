const fs=require('node:fs')
const dashboard=JSON.parse(fs.readFileSync('/tmp/monitoring-dashboard.json','utf8'))
;(async()=>{
 const origin='http://prometheus:9090'
 const targets=(await (await fetch(origin+'/api/v1/targets')).json()).data.activeTargets.map(t=>({labels:t.labels,health:t.health,error:t.lastError}))
 const panels=[]
 for(const panel of dashboard.panels){if(!panel.targets)continue
  const queries=[];for(const target of panel.targets){const r=await fetch(origin+'/api/v1/query?query='+encodeURIComponent(target.expr)),v=await r.json();queries.push({expr:target.expr,status:v.status,error:v.error,series:v.data?.result.length,result:v.data?.result})}
  panels.push({id:panel.id,title:panel.title,queries})
 }
 console.log(JSON.stringify({at:new Date().toISOString(),targets,panels},null,2))
})().catch(e=>{console.error(e);process.exitCode=1})
