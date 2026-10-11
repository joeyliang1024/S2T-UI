const assert=require('node:assert/strict'),{buildSync}=require('esbuild'),{gunzipSync}=require('node:zlib')
const code=buildSync({entryPoints:['src/renderer/src/features/app/services/remote-session-storage.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['../../auth/services/auth-client','../../../shared/i18n']}).outputFiles[0].text
const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,id=>id.includes('auth-client')?{retryableAuthFetch:(...args)=>globalThis.__sessionFetch(...args)}:{activeTranslate:key=>key})
const {remoteSessionStorage}=m.exports
const fixture=[{id:'record',title:'large',transcript:'字幕'.repeat(150000),segments:[],audioKey:'',nativeAudioPath:'/private/local.wav',savedToDisk:true}]
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
;(async()=>{
 let calls=[]
 globalThis.__sessionFetch=async(_url,options)=>{calls.push(options);return reply(200,{version:2})}
 assert.equal(await remoteSessionStorage.save(fixture,1),2)
 assert.equal(calls.length,1);assert.equal(calls[0].headers['content-encoding'],'gzip')
 const original=gunzipSync(Buffer.from(calls[0].body)).toString(),decoded=JSON.parse(original)
 assert.equal(decoded.version,1);assert.equal(decoded.sessions[0].transcript,fixture[0].transcript)
 assert.equal('nativeAudioPath' in decoded.sessions[0],false)
 calls=[]
 globalThis.__sessionFetch=async(_url,options)=>{calls.push(options);return calls.length===1?reply(415,{error:'unsupported'}):reply(200,{version:2})}
 assert.equal(await remoteSessionStorage.save(fixture,1),2);assert.equal(calls.length,2);assert.equal(calls[1].body,original)
 calls=[]
 globalThis.__sessionFetch=async(_url,options)=>{calls.push(options);return reply(409,{error:'HTTP 409'})}
 await assert.rejects(remoteSessionStorage.save(fixture,1),/409/);assert.equal(calls.length,1)
 const compression=globalThis.CompressionStream
 try{
  globalThis.CompressionStream=undefined;calls=[]
  globalThis.__sessionFetch=async(_url,options)=>{calls.push(options);return reply(200,{version:2})}
  assert.equal(await remoteSessionStorage.save(fixture,1),2);assert.equal(calls[0].body,original)
  globalThis.CompressionStream=class { constructor(){let sent=false;return new TransformStream({transform(_chunk,controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(8*1024*1024+1))}}})} }
  calls=[]
  assert.equal(await remoteSessionStorage.save(fixture,1),2);assert.equal(calls[0].body,original,'inefficient or oversized compression falls back to the accepted plain payload')
 }finally{globalThis.CompressionStream=compression;delete globalThis.__sessionFetch}
 console.log('PASS gzip storage payload, original content/version, native-path omission, old-gateway fallback, no conflict retry, and plain-browser compatibility')
})().catch(e=>{console.error(e);process.exitCode=1})
