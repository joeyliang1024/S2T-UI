const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {chromium}=require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
let activeBrowser
const name=process.argv[2]||'baseline',count=Number(process.argv[3]||2400),root=__dirname
;(async()=>{
 const browser=activeBrowser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const segments=Array.from({length:count},(_,i)=>({id:'perf-'+i,startMs:i*1500,endMs:(i+1)*1500,sourceText:'這是模擬會議紀錄，測試字幕閱讀效能'+(i%5===4?'。':''),translatedText:'Simulated meeting transcript '+i+(i%5===4?'.':''),speaker:'SPEAKER_01',status:'final',revision:1,isSentenceBoundary:i%5===4}))
 let settingsVersion=0
 let sessions=[{id:'perf-session',title:'Performance fixture '+count,createdAt:'2026-10-06T00:00:00Z',durationMs:count*1500,source:'microphone',transcript:'Performance fixture',audioKey:'',segments,processingState:'completed'}],version=1
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url())
  if(u.origin!=='http://127.0.0.1:8790')return route.abort()
  if(!u.pathname.startsWith('/api/'))return route.continue()
  if(u.pathname==='/api/config')return route.continue()
  let value={value:null,voiceprints:[],services:[],profiles:[],glossary:'',orphanAudio:0}
  if(u.pathname.startsWith('/api/auth/'))value={user:{id:'browser-perf',username:'browser-perf',NT:'BrowserPerf',Department:'Lab',role:'user',createdAt:'2026-10-06T00:00:00Z'}}
  if(u.pathname==='/api/data/settings'){
   value=route.request().method()==='POST'?{saved:true,version:++settingsVersion}:{settings:null,version:settingsVersion}
  }
  if(u.pathname==='/api/data/sessions'){
   if(route.request().method()==='POST'){const b=route.request().postDataJSON();sessions=b.sessions;version++;value={saved:true,version}}
   else value={sessions,version}
  }
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)})
 })
 await page.addInitScript(()=>{
  window.__longTasks=[]
  new PerformanceObserver(list=>{for(const e of list.getEntries())window.__longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})
 })
 await page.goto('http://127.0.0.1:8790/',{waitUntil:'networkidle'})
 await page.screenshot({path:path.join(root,'results',name+'-initial.png')})
 const historyButton=page.locator('.history-all-button')
 if(await historyButton.isVisible())await historyButton.click()
 else await page.locator('.sidebar-nav-groups button').filter({hasText:/[記紀]錄|记录|History|Recordings/}).first().click({timeout:10000})
 await page.locator('.session-item').first().waitFor()
 await page.evaluate(()=>{window.__longTasks=[]})
 const openStart=Date.now()
 await page.locator('.session-item .session-quick-button').first().click()
 await page.locator('.transcript-modal .record-transcript > article').first().waitFor()
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const openMs=Date.now()-openStart
 const before=await page.evaluate(()=>({nodes:document.querySelectorAll('.record-transcript *').length,groups:document.querySelectorAll('.record-transcript > article').length,memberRows:document.querySelectorAll('.record-transcript details article').length,longTasks:window.__longTasks}))
 await page.screenshot({path:path.join(root,'results',name+'-modal.png')})
 const detailStart=Date.now()
 await page.locator('.record-transcript details summary').first().click()
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const detailMs=Date.now()-detailStart
 const openedMembers=await page.locator('.record-transcript details[open] article').count()
 assert.equal(openedMembers,5)
 await page.locator('.record-transcript details[open] .edit-button').first().click()
 const source=page.locator('.record-transcript .transcript-edit textarea').first()
 await source.fill('Updated performance fixture')
 await source.press('Tab')
 await page.locator('.record-transcript .transcript-edit button').first().click()
 await page.locator('.record-transcript details[open] p').filter({hasText:'Updated performance fixture'}).first().waitFor()
 await page.locator('.record-transcript details[open] summary').first().click()
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const closedMembers=await page.locator('.record-transcript details article').count()
 if(name!=='baseline')assert.equal(closedMembers,0)
 await page.locator('.transcript-tools input').fill('Updated performance fixture')
 await page.locator('.record-transcript > article').first().waitFor()
 assert.equal(await page.locator('.record-transcript > article').count(),1)
 assert.equal(errors.length,0)
 const result={name,segments:count,openMs,detailMs,openedMembers,closedMembers,editingAndSearchPassed:true,...before,pageErrors:errors}
 fs.writeFileSync(path.join(root,'results',name+'-browser.json'),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result))
 await browser.close()
})().catch(async e=>{console.error(e);process.exitCode=1;await activeBrowser?.close()})
