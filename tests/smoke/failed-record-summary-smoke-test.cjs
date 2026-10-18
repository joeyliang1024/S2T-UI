const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const source = fs.readFileSync('src/renderer/src/features/app/hooks/useAppController.ts','utf8')
const code = ts.transpileModule(source.slice(source.indexOf('const summarizeSession ='),source.indexOf('const canRecord =',source.indexOf('const summarizeSession ='))),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
;(async()=>{
  const calls=[],statuses=[],active={current:new Set()}
  const ctx={qualityCorrectionActiveRef:active,setStatus:s=>statuses.push(s),activeTranslate:key=>key,settings:{summaryEndpoint:'/api/summaries',summaryModel:'test'},makeTranscriptText:segments=>segments.map(s=>s.sourceText).join('\n'),createSessionSummary:async(id,text)=>{calls.push({id,text});return true}}
  const summarize=new Function(...Object.keys(ctx),code+';return summarizeSession')(...Object.values(ctx))
  const record={id:'failed-record',transcript:'Usable transcript',segments:[],processingState:'failed',qualityCorrectionState:'failed',qualityCorrectionError:'Prior correction error',summaryError:'Prior summary error'}
  for(const stage of ['asr','translation','diarization','saving']){
    await summarize({...record,processingFailures:[stage],processingError:stage+' failed'})
    assert.deepEqual(calls.at(-1),{id:record.id,text:record.transcript})
    assert.equal(statuses.at(-1),'stMeetingSummaryUpdated')
  }
  assert.equal(calls.length,4)
  await summarize({...record,transcript:'',segments:[{sourceText:'Fallback transcript'}]})
  assert.equal(calls.at(-1).text,'Fallback transcript')
  const count=calls.length
  await summarize({...record,transcript:'',segments:[]})
  assert.equal(calls.length,count);assert.equal(statuses.at(-1),'stNoTranscriptToSummarize')
  await summarize({...record,processingState:'running'})
  assert.equal(calls.length,count)
  active.current.add(record.id);await summarize(record);assert.equal(calls.length,count)
  console.log('PASS failed ASR/translation/diarization/saving records and prior summary/correction errors still summarize; empty and active records remain guarded')
})().catch(error=>{console.error(error);process.exit(1)})
