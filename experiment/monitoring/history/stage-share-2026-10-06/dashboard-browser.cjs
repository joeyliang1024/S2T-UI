const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
let browser
;(async()=>{
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:13000/d/s2t-overview?orgId=1&from=now-30m&to=now',{waitUntil:'networkidle'})
 await page.waitForTimeout(8000)
 await page.getByText('首字延遲時間占比（所選時間範圍）',{exact:true}).waitFor()
 await page.getByText('VAD 語音確認',{exact:true}).waitFor()
 await page.getByText('音訊累積 / 切段',{exact:true}).waitFor()
 await page.getByText('ASR 往返（含 server 排隊與重試）',{exact:true}).waitFor()
 await page.screenshot({path:path.join(__dirname,'results/dashboard.png')})
 await page.screenshot({path:path.join(__dirname,'results/stage-share.png'),clip:{x:316,y:336,width:1268,height:295}})
 const text=await page.locator('body').innerText()
 assert.ok(!/Panel plugin not found|Error loading|Datasource not found/.test(text))
 fs.writeFileSync(path.join(__dirname,'results/dashboard-browser.json'),JSON.stringify({title:await page.title(),errors,text:text.slice(0,16000)},null,2)+'\n');console.log(JSON.stringify({passed:true,title:await page.title(),errors}))
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close()})
