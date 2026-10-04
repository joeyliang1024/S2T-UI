// Isolated local model server. No dotenv, credentials, production storage or
// external fetches. Open the printed URL in a browser to start the wall-time test.
const { createServer } = require('node:http')
const { buildSync } = require('esbuild')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { createRequestLimiter, requestLimits } = require('../../server/request-limits.cjs')
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i+1] : fallback }
const seconds = Number(arg('--seconds', '600'))
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be positive')
const report = arg('--report', join('experiment/evaluation-reports', 'caption-local-10min.json'))
const code = buildSync({ entryPoints: ['tests/fixtures/caption-local-browser.jsx'], bundle: true, platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
const accept = createRequestLimiter(requestLimits({}))
let asr = 0, translations = 0, peak = 0, concurrent = 0, resultReceived = false
const server = createServer(async (request,response) => {
 try {
  if (request.method === 'GET' && request.url === '/') { response.setHeader('content-type','text/html; charset=utf-8'); return response.end(`<!doctype html><html><head><meta charset="utf-8"><title>本機字幕測試</title><style>body{font:16px system-ui;margin:24px}article{padding:8px;border-bottom:1px solid #ddd}#captions{max-height:70vh;overflow:auto}</style></head><body><h1>本機字幕與翻譯測試</h1><p>本機模擬模型，零外部 API 用量。</p><p id="progress">開始測試 ${seconds} 秒…</p><p id="status">執行中</p><div id="captions"></div><script>window.localTestDurationMs=${seconds*1000}</script><script src="/bundle.js"></script></body></html>`) }
  if (request.method === 'GET' && request.url === '/bundle.js') { response.setHeader('content-type','text/javascript'); return response.end(code) }
  if (request.method !== 'POST') { response.statusCode=404;return response.end() }
  const chunks=[]; let bytes=0; for await(const chunk of request){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Test payload too large');chunks.push(chunk)}
  if (request.url === '/progress') { console.log('progress', Buffer.concat(chunks).toString());response.end('{}');return }
  if (request.url === '/result') {
    const result=JSON.parse(Buffer.concat(chunks));result.localServer={asrRequests:asr,translationRequests:translations,peakConcurrent:peak};
    mkdirSync(require('node:path').dirname(report),{recursive:true});writeFileSync(report,JSON.stringify(result,null,2)+'\n');resultReceived=true;
    console.log('result',JSON.stringify({passed:result.passed,captions:result.captions,translated:result.translated,report}));response.end('{}');server.close();process.exitCode=result.passed?0:1;return
  }
  const bucket=request.url==='/api/transcriptions'?'transcriptions':request.url==='/api/translations'?'translations':null
  if(!bucket){response.statusCode=404;return response.end()}
  const limit=accept('isolated-test-account',bucket)
  response.setHeader('content-type','application/json')
  if(!limit.accepted){response.statusCode=429;response.setHeader('retry-after',String(limit.retryAfterSeconds));return response.end(JSON.stringify({error:'Local gateway rate limit',retryAfterSeconds:limit.retryAfterSeconds}))}
  const n=bucket==='transcriptions'?++asr:++translations; concurrent++;peak=Math.max(peak,concurrent)
  setTimeout(()=>{concurrent--;response.end(JSON.stringify({text:bucket==='transcriptions'?`字幕${n}`:`翻譯${n}`,detectedLanguage:'zh-TW'}))},bucket==='transcriptions'?300:100)
 }catch(error){response.statusCode=500;response.end(JSON.stringify({error:error.message}))}
})
server.listen(0,'127.0.0.1',()=>console.log(`Local caption test ready: http://127.0.0.1:${server.address().port}/ (${seconds}s, zero external API calls)`))
const guard=setTimeout(()=>{if(!resultReceived){console.error('Browser test did not complete');server.close();process.exitCode=1}},(seconds+180)*1000)
guard.unref()
server.on('close',()=>clearTimeout(guard))
