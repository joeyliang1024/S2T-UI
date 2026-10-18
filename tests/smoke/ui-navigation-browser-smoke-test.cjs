// Real production UI, isolated account data and APIs; exercises history/navigation and layout.
const assert = require('node:assert/strict')
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  const root = path.resolve('out/web')
  const server = http.createServer((req,res) => {
    let file = path.join(root,new URL(req.url,'http://fixture').pathname)
    if (!file.startsWith(root+path.sep)) return res.writeHead(403).end()
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file=path.join(root,'index.html')
    res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  const browser=await chromium.launch(browserOptions())
  let sessions=Array.from({length:26},(_,i)=>({id:`record-${i}`,title:`Record ${String(i).padStart(2,'0')}`,createdAt:new Date(Date.UTC(2026,9,1+i)).toISOString(),durationMs:(i+1)*1000,source:'fixture',audioKey:`audio-${i}`,transcript:`Original ${i}`,segments:[{id:`segment-${i}`,status:'final',revision:1,startMs:0,endMs:1000,sourceText:`Original ${i}`,speaker:`Speaker ${i}`,translatedText:`Translated ${i}`}]}))
  const wave=Buffer.alloc(44+32000)
  wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(32000,40)
  let sessionVersion=0, modelCalls=0
  const errors=[]
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    page.setDefaultTimeout(10000)
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin})
    page.on('pageerror',error=>errors.push(error.message));page.on('crash',()=>errors.push('page crashed'))
    await page.route('**/api/**',async route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname
      const body=request.postData()&&request.headers()['content-type']?.includes('application/json')?JSON.parse(request.postData()):{}
      if(pathname.startsWith('/api/data/audio/')){await route.fulfill({status:200,contentType:'audio/wav',body:wave});return}
      let result={}, status=200
      if(pathname==='/api/auth/session')result={user:{id:'navigation',username:'navigation',NT:'Navigation',Department:'QA',role:'user',createdAt:'2026-10-18'}}
      else if(pathname==='/api/config')result={asr:{configured:true,endpoint:'/api/transcriptions',model:'fixture'},asrProfiles:[],summary:{configured:true,endpoint:'/api/summaries',model:'fixture'},translation:{configured:true,endpoint:'/api/translations',model:'fixture'},diarization:{configured:false}}
      else if(pathname==='/api/data/settings')result=request.method()==='POST'?{version:1}:{settings:{uiLanguage:'en'},version:0}
      else if(pathname==='/api/data/sessions'){if(request.method()==='POST'){sessions=body.sessions;sessionVersion++}result=request.method()==='POST'?{version:sessionVersion}:{sessions,version:sessionVersion}}
      else if(pathname==='/api/data/model-registry')result={models:[],version:0}
      else if(pathname==='/api/data/summary-templates')result={templates:[{id:'base',name:'Base',content:'# Summary'}],selectedTemplateId:'base',version:0}
      else if(pathname==='/api/data/voiceprints')result={voiceprints:[]}
      else if(pathname==='/api/data/storage-status')result={audioPending:0,voiceprintPending:0}
      else if(pathname==='/api/data/storage-audit')result={orphanAudio:0}
      else if(['/api/transcriptions','/api/translations','/api/summaries','/api/diarizations'].includes(pathname)){modelCalls++;status=503;result={error:'No inference expected during navigation'}}
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)})
    })
    await page.goto(origin+'/history')
    await page.locator('.session-item').first().waitFor()
    assert.equal(await page.locator('.session-item').count(),10)
    await page.getByLabel('Next',{exact:true}).click()
    assert.match(await page.locator('.history-page-indicator').innerText(),/2/)
    await page.getByLabel('Per page',{exact:true}).selectOption('100')
    assert.equal(await page.locator('.session-item').count(),26)
    await page.getByLabel('Sort',{exact:true}).selectOption('durationMs')
    assert.equal(await page.locator('.session-title').first().innerText(),'Record 25')
    await page.locator('.history-dir-button').click()
    assert.equal(await page.locator('.session-title').first().innerText(),'Record 00')
    const search=page.getByLabel('Search records',{exact:true})
    await search.fill('  ＲＥＣＯＲＤ ０７ ')
    assert.equal(await page.locator('.session-item').count(),1)
    const card=page.locator('.session-item')
    await card.getByLabel('View captions',{exact:true}).click()
    const transcript=page.locator('.record-transcript')
    const recordSearch=page.getByLabel('Search this recording',{exact:true})
    await recordSearch.fill('ＴＲＡＮＳＬＡＴＥＤ ７')
    assert.match(await transcript.innerText(),/Original 7/)
    assert.match(await transcript.innerText(),/Translated 7/)
    await recordSearch.fill('missing-result')
    assert.equal(await transcript.locator('article').count(),0)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.record-transcript').count(),0)
    await card.getByLabel('View captions',{exact:true}).click()
    assert.equal(await recordSearch.inputValue(),'','opening a record resets its search')
    await recordSearch.fill('another missing result')
    await page.locator('.transcript-modal-backdrop').click({position:{x:2,y:2}})
    await card.getByLabel('View captions',{exact:true}).click()
    assert.equal(await recordSearch.inputValue(),'','backdrop close also clears search')
    await page.getByRole('button',{name:'Close',exact:true}).click()
    await card.locator('.session-title').click()
    await page.getByLabel('Recording title',{exact:true}).fill('Cancelled rename')
    await page.keyboard.press('Escape')
    assert.equal(await card.locator('.session-title').innerText(),'Record 07')
    await card.locator('.session-title').click()
    await page.getByLabel('Recording title',{exact:true}).fill('Renamed Record 07')
    await page.getByLabel('Recording title',{exact:true}).press('Enter')
    assert.equal(await card.locator('.session-title').innerText(),'Renamed Record 07')
    await card.getByLabel('Play recording',{exact:true}).click()
    await card.locator('audio').waitFor()
    await card.getByLabel('Collapse player',{exact:true}).click()
    assert.equal(await card.locator('audio').count(),0)
    await card.locator('.session-more-button').click()
    await page.getByRole('menuitem',{name:'Copy transcript',exact:true}).click()
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/Translated 7/)
    for(const format of ['TXT','CSV','VTT','DOCX','XLSX']){
      await card.locator('.session-more-button').click()
      await page.getByRole('menuitem',{name:'Download transcript',exact:true}).click()
      const downloaded = page.waitForEvent('download')
      await page.locator('.download-picker-options button').filter({has:page.locator('.download-format-badge').filter({hasText:new RegExp('^'+format+'$')})}).click()
      const file=await downloaded
      const data=fs.readFileSync(await file.path())
      assert.ok(data.length>0)
      if(['DOCX','XLSX'].includes(format))assert.equal(data.subarray(0,2).toString(),'PK')
      else assert.match(data.toString(),/Original 7/)
      await page.locator('.download-picker').waitFor({state:'detached'})
    }

    await card.locator('.session-more-button').click()
    await page.getByRole('menuitem',{name:'Summary',exact:true}).click()
    await page.locator('.summary-workspace').waitFor()
    assert.equal(await page.locator('.summary-setup select').first().inputValue(),'record-7')
    assert.equal(modelCalls,0,'navigation never starts a model request')
    await page.goBack();await page.locator('.session-item').first().waitFor()
    await search.fill('Record 07')
    await page.locator('.session-item .session-more-button').click()
    await page.getByRole('menuitem',{name:'Quality correction',exact:true}).click()
    await page.locator('.quality-comparison').waitFor()
    assert.equal(await page.locator('.quality-comparison-controls select').inputValue(),'record-7')
    await page.locator('.quality-correction-trigger').click()
    await page.getByRole('checkbox',{name:'Transcript',exact:true}).uncheck()
    assert.equal(await page.getByRole('button',{name:'Quality correction',exact:true}).isDisabled(),true)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.quality-correction-trigger').getAttribute('aria-expanded'),'false')
    // Common widths/themes; page controls remain reachable without document overflow.
    for(const route of ['history','summary','quality-comparison','models','settings','voiceprints','import']){
      await page.goto(origin+'/'+route);await page.locator('.workspace-content').waitFor()
      for(const theme of ['dark','light'])for(const width of [1440,768,390]){
        await page.evaluate(value=>document.documentElement.dataset.theme=value,theme)
        await page.setViewportSize({width,height:1000})
        const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:window.innerWidth}))
        assert.ok(size.scroll<=size.width+2,`${route}/${theme}/${width}: document overflow ${size.scroll}`)
      }
    }
    await page.goto(origin+'/settings');await page.locator('.workspace-content').waitFor()
    assert.equal(await page.getByRole('button',{name:'Accounts / admin parameters',exact:true}).count(),0,'normal users cannot enter admin UI')
    assert.equal(modelCalls,0)
    assert.deepEqual(errors,[])
    console.log('PASS history paging/sort/search, transcript searches/close/reset, cancelled rename, selected-record redirects, no accidental inference, 42 responsive/theme page combinations and admin visibility')
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1})
