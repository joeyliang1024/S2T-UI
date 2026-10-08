const assert=require('node:assert/strict')
;(async()=>{
 const base='http://prometheus:9090/api/v1/query?query=',query=async expr=>(await(await fetch(base+encodeURIComponent(expr))).json())
 const v=await query('sum(increase(s2t_first_word_stage_duration_seconds_sum[30m])) by (stage) / scalar(sum(increase(s2t_first_word_stage_duration_seconds_sum[30m])))')
 assert.equal(v.status,'success');assert.equal(v.data.result.length,6)
 const percentages=v.data.result.map(r=>({stage:r.metric.stage,percent:Number(r.value[1])*100}))
 assert.ok(percentages.every(r=>Number.isFinite(r.percent)&&r.percent>=0))
 assert.ok(Math.abs(percentages.reduce((sum,r)=>sum+r.percent,0)-100)<1e-8)
 const counts=await query('sum(s2t_first_word_stage_duration_seconds_count) by (stage)');assert.equal(new Set(counts.data.result.map(r=>r.value[1])).size,1)
 const targets=(await(await fetch('http://prometheus:9090/api/v1/targets')).json()).data.activeTargets
 assert.ok(targets.every(t=>t.health==='up'))
 console.log(JSON.stringify({passed:true,percentages,counts:counts.data.result.map(r=>({stage:r.metric.stage,count:Number(r.value[1])})),targets:targets.length},null,2))
})().catch(e=>{console.error(e);process.exitCode=1})
