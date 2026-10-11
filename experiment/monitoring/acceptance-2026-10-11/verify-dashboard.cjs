const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const base='http://127.0.0.1:13000',queryTime=Date.now()/1000
const query=async expression=>{const response=await fetch(base+'/api/datasources/proxy/uid/s2t-prometheus/api/v1/query?query='+encodeURIComponent(expression)+'&time='+queryTime);const value=await response.json();assert.equal(value.status,'success',JSON.stringify(value));return value.data.result}
;(async()=>{
 const up=await query('up{job="gateway-acceptance"}');assert.equal(up[0]?.value[1],'1')
 const requests=await query('sum(s2t_user_requests_total{job="gateway-acceptance"}) by (user_id)');assert.equal(requests.length,3);assert.ok(requests.every(row=>Number(row.value[1])>0))
 const departments=await query('sum(s2t_user_requests_total{job="gateway-acceptance"}) by (department)');assert.equal(departments.length,2)
 const ntUsage=await query('sum(s2t_user_requests_total{job="gateway-acceptance",nt!="",department!=""}) by (nt)');assert.equal(ntUsage.length,3);assert.ok(ntUsage.every(row=>row.metric.nt.startsWith('驗收使用者')));assert.equal(departments.reduce((sum,row)=>sum+Number(row.value[1]),0),ntUsage.reduce((sum,row)=>sum+Number(row.value[1]),0))
 const tokens=await query('sum(s2t_user_input_tokens_total{job="gateway-acceptance"})');assert.ok(Number(tokens[0]?.value[1])>0)
 const duration=await query('sum(s2t_user_audio_seconds_total{job="gateway-acceptance"})');assert.ok(Number(duration[0]?.value[1])>0)
 const delta=await query('sum(increase(s2t_user_requests_total{job="gateway-acceptance"}[5m]))');assert.ok(Number(delta[0]?.value[1])>0)
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  const url=base+'/d/s2t-overview?orgId=1&from=now-15m&to=now&refresh=5s&var-caption_gateway=gateway-acceptance&var-usage_user=$__all&var-usage_department=$__all'
  await page.goto(url,{waitUntil:'networkidle'});await page.waitForTimeout(1500)
  await page.screenshot({path:path.join(__dirname,'dashboard-top.png')})
  const heading=page.getByText(/^使用量 ·/).first()
  await page.mouse.move(1000,600)
  for(let i=0;i<25 && !await heading.count();i++){await page.mouse.wheel(0,750);await page.waitForTimeout(250)}
  await heading.evaluate(element=>{element.style.scrollMarginTop='155px';element.scrollIntoView({block:'start'})});await page.waitForTimeout(1000)
  await page.screenshot({path:path.join(__dirname,'dashboard-usage.png')})
  const visible=await page.locator('body').innerText()
  const ntChart=page.getByText('使用者請求數比較（依 NT）',{exact:true}).first();await ntChart.scrollIntoViewIfNeeded();await page.waitForTimeout(1000);assert.ok((await page.locator('body').innerText()).includes('驗收使用者甲'));assert.ok(!visible.includes('Panel plugin not found'));assert.deepEqual(errors,[])
  const departmentHeading=page.getByText(/^部門總體用量/).first();for(let i=0;i<25&&!await departmentHeading.count();i++){await page.mouse.wheel(0,750);await page.waitForTimeout(200)}
  await departmentHeading.evaluate(element=>{element.style.scrollMarginTop='155px';element.scrollIntoView({block:'start'})});await page.waitForTimeout(1200);await page.screenshot({path:path.join(__dirname,'dashboard-departments.png')});assert.ok((await page.locator('body').innerText()).includes('驗收研發部'));
  await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({passed:true,url,source:'gateway-acceptance',synthetic:true,requests,ntUsage,departments,tokens,duration,delta,browserErrors:errors},null,2)+'\n')
  console.log(JSON.stringify({passed:true,url,users:requests.map(row=>({user:row.metric.user_id,requests:row.value[1]})),tokens:tokens[0].value[1],audioSeconds:duration[0].value[1]}))
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
