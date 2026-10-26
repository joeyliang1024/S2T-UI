const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { writeFileSync, readFileSync } = require('node:fs')
const { request } = require('playwright')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
const { readEnv } = require('../../scripts/runtime.cjs')
const config = { ...readEnv('deploy/k8s/.env'), ...process.env }
const k = [...(config.K8S_CONTEXT ? ['--context', config.K8S_CONTEXT] : []), '-n', config.K8S_NAMESPACE || 's2t-web']
const prom = 'http://127.0.0.1:9090', grafana = 'http://127.0.0.1:3000'
if (process.env.S2T_ALLOW_DEPLOYMENT_TESTS !== 'true') throw new Error('Use S2T_ALLOW_DEPLOYMENT_TESTS=true in the local isolated cluster')
;(async()=>{
 const secret = JSON.parse(execFileSync('kubectl',[...k,'get','secret','monitoring-credentials','-o','json'],{encoding:'utf8'}))
 const password = Buffer.from(secret.data['grafana-password'],'base64').toString()
 const api = await request.newContext({httpCredentials:{username:'admin',password,origin:grafana}})
 let browser
 try {
  for(const url of [grafana+'/api/health',prom+'/-/ready']){
   for(let attempt=0;attempt<20;attempt++){
    try{if((await api.get(url,{timeout:3000})).ok())break}catch{}
    assert.ok(attempt<19,'monitoring forwarding did not become ready');await new Promise(r=>setTimeout(r,500))
   }
  }
  const dashboard = await (await api.get(grafana+'/api/dashboards/uid/s2t-overview')).json()
  assert.equal(dashboard.dashboard.templating.list.find(x=>x.name==='caption_gateway').current.value,'s2t')
  const targets = await (await api.get(prom+'/api/v1/targets')).json()
  const backendTargets = targets.data.activeTargets.filter(x=>x.labels.job==='s2t')
  assert.equal(backendTargets.length,2);assert.ok(backendTargets.every(x=>x.health==='up'))
  const query = async expr => {const r=await api.get(prom+'/api/v1/query',{params:{query:expr}});const d=await r.json();assert.equal(d.status,'success',expr);return d.data.result}
  const clock = await query('time()'), clockDifference = Math.abs(Number(clock[1]) - Date.now()/1000)
  assert.ok(clockDifference<2,'Prometheus wall clock must match host within 2 seconds')
  const evidence = {backendTargets:backendTargets.map(x=>({pod:x.labels.pod,health:x.health})),clockDifferenceSeconds:clockDifference,queries:{},dashboardQueryErrors:[],emptyPanels:[]}
  for(const expr of ['s2t_process_resident_memory_bytes{job="s2t"}','s2t_event_loop_p99_seconds{job="s2t"}','sum(s2t_gateway_request_duration_seconds_count{job="s2t"})','sum by(stage)(s2t_caption_stage_duration_seconds_count{job="s2t",stage=~"e2e_asr|e2e_translation_tail"})','histogram_quantile(0.90,sum by(stage,le)(rate(s2t_caption_stage_duration_seconds_bucket{job="s2t",stage=~"e2e_asr|e2e_translation_tail"}[5m])))']){
   const values=await query(expr);assert.ok(values.length,expr+' has no samples');evidence.queries[expr]=values
  }
  // Compare the exact values accepted from the real browser with the sum/count
  // series on only the currently running Pods; P90 remains a bucket estimate.
  const validation = JSON.parse(readFileSync('/private/tmp/s2t-k8s-validation.json','utf8'))
  const measuredResult = validation.results.find(x=>x.measuredSeconds)
  const browserMeasurements = measuredResult?.measuredSeconds
  assert.ok(browserMeasurements)
  assert.deepEqual([...measuredResult.browserPods].sort(),backendTargets.map(x=>x.labels.pod).sort(),'browser baseline must belong to current Pods')
  const podFilter = backendTargets.map(x=>x.labels.pod).join('|')
  evidence.browserToPrometheus = {}
  for(const [stage,values] of Object.entries(browserMeasurements)){
   const selector=`job="s2t",pod=~"${podFilter}",stage="${stage}"`
   const expected=values.reduce((a,b)=>a+b,0)
   const baseline=measuredResult.browserBaseline?.[stage]||{count:0,sum:0}
   let count,sum
   for(let attempt=0;attempt<20;attempt++){
    count=Number((await query(`sum(s2t_caption_stage_duration_seconds_count{${selector}})`))[0]?.value[1])
    sum=Number((await query(`sum(s2t_caption_stage_duration_seconds_sum{${selector}})`))[0]?.value[1])
    if(count-baseline.count>=values.length)break
    await new Promise(resolve=>setTimeout(resolve,2000))
   }
   assert.equal(count-baseline.count,values.length,stage+' accepted sample count')
   assert.ok(Math.abs(sum-baseline.sum-expected)<1e-8,stage+' seconds must not be rescaled or counted twice')
   evidence.browserToPrometheus[stage]={count:count-baseline.count,sumSeconds:sum-baseline.sum,browserSumSeconds:expected}
  }
  for(const panel of dashboard.dashboard.panels)for(const target of panel.targets||[]){
   if(!target.expr)continue
   const expr=target.expr.replace(/\$caption_gateway/g,'s2t').replace(/\$__rate_interval|\$__interval/g,'1m').replace(/\$__range/g,'15m').replace(/\$\{(?:usage_department|usage_user):regex\}|\$usage_department|\$usage_user/g,'.*')
   try{if(!(await query(expr)).length)evidence.emptyPanels.push(panel.title)}catch(e){evidence.dashboardQueryErrors.push({panel:panel.title,error:e.message})}
  }
  const performanceDashboard=await (await api.get(grafana+'/api/dashboards/uid/s2t-performance-500')).json()
  assert.match(performanceDashboard.dashboard.title,/Python/)
  for(const panel of performanceDashboard.dashboard.panels)for(const target of panel.targets||[]){
   try{await query(target.expr)}catch(e){evidence.dashboardQueryErrors.push({panel:panel.title,error:e.message})}
  }
  evidence.performanceDashboardPanels=performanceDashboard.dashboard.panels.length
  assert.deepEqual(evidence.dashboardQueryErrors,[])
  browser=await chromium.launch(browserOptions())
  const page=await browser.newPage({viewport:{width:1600,height:1100}})
  await page.goto(grafana+'/login')
  await page.locator('input[name="user"]').fill('admin');await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button',{name:/log in/i}).click()
  await page.waitForURL(url=>!url.pathname.includes('/login'),{timeout:30000})
  await page.goto(grafana+'/d/s2t-overview?from=now-15m&to=now&var-caption_gateway=s2t')
  await page.waitForTimeout(5000)
  const text=await page.locator('body').innerText();assert.ok(text.includes('ASR'))
  await page.screenshot({path:'/private/tmp/s2t-grafana-validated.png',fullPage:true})
  await page.goto(grafana+'/d/s2t-performance-500?from=now-15m&to=now')
  await page.waitForTimeout(3000)
  await page.screenshot({path:'/private/tmp/s2t-grafana-performance-validated.png',fullPage:true})
  writeFileSync('/private/tmp/s2t-monitoring-validation.json',JSON.stringify(evidence,null,2)+'\n')
  console.log('PASS Grafana dashboard, all PromQL syntax, two healthy backend scrape targets, runtime/caption series, host/Prometheus clock and real browser rendering')
  console.log('Prometheus clock difference:',clockDifference.toFixed(3),'seconds')
 }finally{await browser?.close();await api.dispose()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
