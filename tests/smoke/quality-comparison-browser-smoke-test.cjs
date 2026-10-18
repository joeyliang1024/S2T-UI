const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const fs = require('node:fs/promises')
const { build } = require('esbuild')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  let browser
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {QualityComparisonWorkspace} from './src/renderer/src/features/quality-comparison/views/QualityComparisonWorkspace';
    import {interfaceTranslate} from './src/renderer/src/shared/i18n';
    const original = '今天討論產品上線的計畫。\\n下個星期三進行內側。\\n預計邀請十位同事參與。';
    const corrected = '今天討論產品上線計畫。\\n下個星期三進行內測。\\n預計邀請十二位同事參與。';
    const segment={id:'s',status:'final',sourceText:original,speaker:'SPEAKER_01',translatedText:'Old translation',startMs:0,endMs:1000,revision:1};
    const record={id:'a',title:'產品會議 · 測試紀錄',createdAt:'2026-10-17T12:00:00Z',durationMs:1000,audioKey:'fixture',source:'microphone',transcript:original,segments:[segment]};
    window.calls=0;
    function App(){
      const [sessions,setSessions]=useState([record,{...record,id:'b',title:'第二筆測試紀錄',transcript:'另一筆內容',segments:[{...segment,sourceText:'另一筆內容'}]}]);
      const [progress,setProgress]=useState({});
      const [selectedId,setSelectedId]=useState('b');
      window.stress=()=>{
        const before=Array.from({length:1000},(_,i)=>({...segment,id:'stress-'+i,startMs:i*1000,endMs:(i+1)*1000,sourceText:'校正前的長篇測試會議內容 '+i,translatedText:'Original translation '+i}));
        const after=before.map(item=>({...item,sourceText:item.sourceText.replace('前','後'),speaker:'SPEAKER_02',translatedText:item.translatedText.replace('Original','Corrected')}));
        setSessions([{...record,id:'stress',title:'長標題'.repeat(60),segments:after,transcript:'',activeAudioVersionId:'new',audioVersions:[{id:'old',segments:before},{id:'new',parentId:'old',segments:after}]}]);setSelectedId('stress');setProgress({});
      };
      window.clear=()=>setSessions([]);

      const correct=(entry,items)=>new Promise(resolve=>{
        window.lastItems=items;window.calls++;setProgress(p=>({...p,[entry.id]:{stage:'asr',completed:1,total:3}}));
        window.finish=()=>{setSessions(s=>s.map(item=>item.id===entry.id?{...item,transcript:corrected,segments:[{...segment,sourceText:corrected,speaker:'SPEAKER_02',translatedText:'New translation'}],qualityCorrectionState:'completed',activeAudioVersionId:'corrected',audioVersions:[{id:'original',transcript:entry.transcript},{id:'corrected',parentId:'original',transcript:corrected}]}:item));setProgress(p=>({...p,[entry.id]:{stage:'completed',completed:3,total:3}}));resolve()};
        window.fail=()=>{setProgress(p=>({...p,[entry.id]:{stage:'failed',completed:1,total:3,error:'測試服務失敗，保留原文'}}));resolve()};
      });
      return <main style={{padding:32,maxWidth:1440,margin:'auto'}}><QualityComparisonWorkspace sessionId={selectedId} onSelectSession={setSelectedId} sessions={sessions} progress={progress} correct={correct} canCorrect={true} ui={key=>interfaceTranslate('zh-TW',key)}/></main>
    }createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, define: { 'process.env.NODE_ENV': '"production"' }, format: 'iife', write: false })
  const css = await fs.readFile('src/renderer/src/styles.css')
  const server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('content-type', 'application/javascript'); return res.end(bundle.outputFiles[0].contents) }
    if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end(css) }
    res.setHeader('content-type', 'text/html');res.end('<html data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script></html>')
  })
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    browser = await chromium.launch(browserOptions())
    const page = await browser.newPage({viewport:{width:1440,height:1000}})
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('crash', () => pageErrors.push('page crashed'))
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'})
    assert.equal(await page.getByRole('combobox').inputValue(),'b')
    assert.match(await page.locator('.quality-diff-body').innerText(),/另一筆內容/)
    assert.equal(await page.evaluate(()=>window.calls),0)
    await page.getByRole('combobox').selectOption('a')
    const button = page.getByRole('button',{name:'品質校正',exact:true})
    await page.getByRole('button',{name:'修正項目',exact:true}).click()
    await page.getByRole('checkbox',{name:'字幕',exact:true}).uncheck()
    await page.getByRole('checkbox',{name:'講者分離',exact:true}).uncheck()
    assert.equal(await button.isDisabled(),true,'unchecking every item safely disables correction')
    assert.equal(await page.getByRole('button',{name:'修正項目',exact:true}).getAttribute('aria-expanded'),'true')
    await page.getByRole('checkbox',{name:'字幕',exact:true}).focus()
    await page.keyboard.press('Space')
    assert.equal(await page.getByRole('checkbox',{name:'字幕',exact:true}).isChecked(),true)

    await page.getByRole('checkbox',{name:'翻譯',exact:true}).check()
    for (let i=0;i<6;i++) { await page.getByRole('checkbox',{name:'翻譯',exact:true}).uncheck(); await page.getByRole('checkbox',{name:'翻譯',exact:true}).check() }
    assert.equal(await page.getByRole('checkbox',{name:'字幕',exact:true}).isChecked(),true)
    assert.equal(await page.getByRole('checkbox',{name:'講者分離',exact:true}).isChecked(),false)
    assert.equal(await page.getByRole('checkbox',{name:'翻譯',exact:true}).isChecked(),true)

    await button.click()
    assert.equal(await page.locator('progress').getAttribute('value'),'1')
    assert.equal(await page.getByRole('button',{name:'品質校正中…'}).isDisabled(),true)
    assert.equal(await page.evaluate(()=>window.calls),1)
    assert.deepEqual(await page.evaluate(()=>window.lastItems),['transcript','translation'])
    await page.getByRole('combobox').selectOption('b')
    assert.match(await page.locator('.quality-diff-body').innerText(),/另一筆內容/)
    await page.evaluate(()=>window.finish())
    assert.doesNotMatch(await page.locator('.quality-diff-body').innerText(),/十二位/)
    await page.getByRole('combobox').selectOption('a')
    await page.waitForFunction(()=>[...document.querySelectorAll('.quality-diff-after')].some(row=>row.textContent.includes('內測')))
    assert.match(await page.locator('.quality-diff-before').allTextContents().then(x=>x.join('')),/內側/)
    assert.match(await page.locator('.quality-diff-after').allTextContents().then(x=>x.join('')),/十二位/)
    await page.getByRole('tab',{name:'講者分離',exact:true}).click()
    assert.match(await page.locator('.quality-diff-before').innerText(), /SPEAKER_01/)
    assert.match(await page.locator('.quality-diff-after').innerText(), /SPEAKER_02/)
    assert.doesNotMatch(await page.locator('.quality-diff-body').innerText(), /內測|translation/)
    await page.getByRole('tab',{name:'翻譯',exact:true}).click()
    assert.match(await page.locator('.quality-diff-before').innerText(), /Old translation/)
    assert.match(await page.locator('.quality-diff-after').innerText(), /New translation/)
    assert.equal(await page.evaluate(()=>window.calls),1,'tabs do not trigger correction')
    await page.getByRole('tab',{name:'字幕',exact:true}).click()
    await page.screenshot({path:'/tmp/s2t-quality-comparison-dark.png',fullPage:true})
    await page.evaluate(()=>document.documentElement.dataset.theme='light')
    await page.screenshot({path:'/tmp/s2t-quality-comparison-light.png',fullPage:true})
    await button.click()
    await page.evaluate(()=>window.fail())
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(),/保留原文/)
    assert.equal(await button.isEnabled(),true)
    await page.evaluate(()=>window.stress())
    await page.waitForFunction(()=>document.querySelectorAll('.quality-diff-row').length>=1000)
    await page.getByRole('button',{name:'修正項目',exact:true}).click()
    for(let i=0;i<12;i++){
      await page.getByRole('checkbox',{name:'字幕',exact:true}).uncheck()
      await page.getByRole('checkbox',{name:'字幕',exact:true}).check()
    }
    assert.equal(await page.evaluate(()=>window.calls),2,'stress toggles never start an API call')
    await page.keyboard.press('Escape')
    await page.setViewportSize({width:390,height:844})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'long recording title stays inside mobile layout')
    await page.evaluate(()=>window.clear())
    assert.equal(await page.locator('.quality-diff-scroll').count(),0)
    assert.equal(await page.getByRole('button',{name:'品質校正',exact:true}).isDisabled(),true)
    assert.deepEqual(pageErrors, [])
    console.log('PASS real browser: record selection, correction click, progress/duplicate lock, background selection isolation, old/new highlights, retry after failure, light/dark layouts')
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)) }
})().catch(error=>{console.error(error);process.exit(1)})
