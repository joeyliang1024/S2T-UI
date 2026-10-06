const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
let browser
;(async()=>{
 const username=fs.readFileSync(path.join(__dirname,'results/browser-username.txt'),'utf8').trim(),origin='http://127.0.0.1:8790'
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],posts=[]
 page.on('pageerror',e=>errors.push(e.message))
 page.on('response',r=>{if(r.url().endsWith('/api/data/sessions')&&r.request().method()==='POST')posts.push({status:r.status(),encoding:r.request().headers()['content-encoding'],bytes:r.request().postDataBuffer()?.length})})
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
 const login=await context.request.post(origin+'/api/auth/login',{data:{username,password:'large-history-test-only'}});assert.equal(login.status(),200)
 await page.goto(origin+'/',{waitUntil:'networkidle'})
 await page.locator('.sidebar-nav-groups button').filter({hasText:/[記紀]錄|记录|History|Recordings/}).first().click()
 await page.locator('.session-item').first().waitFor()
 const title='Browser gzip verified '+Date.now(),start=Date.now()
 await page.locator('.session-item .session-title').first().click()
 await page.locator('.session-rename input').fill(title)
 await page.locator('.session-rename input').press('Enter')
 let saved=false
 for(let i=0;i<80;i++){
  const data=await context.request.get(origin+'/api/data/sessions').then(r=>r.json())
  if(data.sessions.some(s=>s.title===title)){saved=true;break}
  await page.waitForTimeout(100)
 }
 assert.ok(saved,'actual browser edit must reach persistent storage')
 assert.ok(posts.some(p=>p.status===200&&p.encoding==='gzip'),'native browser save must use accepted gzip')
 assert.equal(errors.length,0)
 await page.screenshot({path:path.join(__dirname,'results/browser.png')})
 const output={passed:true,records:40,editSaveMs:Date.now()-start,posts,pageErrors:errors}
 fs.writeFileSync(path.join(__dirname,'results/browser.json'),JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(output))
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close()})
