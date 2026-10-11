const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const base='http://127.0.0.1:13000'
;(async()=>{
 let response,snapshot;for(let attempt=0;attempt<45;attempt++){response=await fetch(base+'/api/dashboards/uid/s2t-oncall');if(response.status===200){snapshot=await response.json();if(snapshot.dashboard.panels.some(panel=>panel.fieldConfig?.overrides?.some(override=>override.matcher?.options==='auth_register')))break}await new Promise(resolve=>setTimeout(resolve,2000))}assert.equal(response.status,200)
 const {dashboard}=snapshot,rows=dashboard.panels.filter(p=>p.type==='row');assert.deepEqual(rows.map(row=>row.title.slice(0,2)),['01','02','03']);assert.ok(rows[0].title.includes('延遲')&&rows[1].title.includes('使用者')&&rows[2].title.includes('請求'))
 let checked=0
 for(const panel of dashboard.panels)for(const target of panel.targets||[]){
  const expression=target.expr.replaceAll('$caption_gateway','gateway-acceptance').replaceAll('$usage_user','.*').replaceAll('$usage_department','.*').replaceAll('$__rate_interval','5m').replaceAll('$__range','15m')
  const query=await(await fetch(base+'/api/datasources/proxy/uid/s2t-prometheus/api/v1/query?query='+encodeURIComponent(expression))).json();assert.equal(query.status,'success',expression+' '+JSON.stringify(query));checked++
 }
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1400}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  const url=base+'/d/s2t-oncall?from=now-15m&to=now&refresh=5s&var-caption_gateway=gateway-acceptance&var-usage_user=$__all&var-usage_department=$__all'
  await page.goto(url,{waitUntil:'networkidle'});await page.waitForTimeout(1500)
  const body=await page.locator('body').innerText();assert.ok(body.includes('驗收使用者甲')&&body.includes('驗收研發部'));assert.ok(!body.includes('Panel plugin not found'));assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(__dirname,'dashboard-oncall.png'),fullPage:true})
  await fs.writeFile(path.join(__dirname,'oncall-result.json'),JSON.stringify({passed:true,url,queriesChecked:checked,rowOrder:rows.map(row=>row.title),browserErrors:errors},null,2)+'\n')
  console.log(JSON.stringify({passed:true,queriesChecked:checked,rowOrder:rows.map(row=>row.title),url}))
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
