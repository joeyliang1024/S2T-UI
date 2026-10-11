const fs=require('node:fs'),assert=require('node:assert/strict'),{gzipSync}=require('node:zlib')
;(async()=>{
 const u=JSON.parse(fs.readFileSync('/tmp/stress-users.json'))[0],url='http://gateway:8787/api/data/sessions',headers={authorization:'Bearer '+u.token,'content-type':'application/json'}
 const before=await fetch(url,{headers}).then(r=>r.json()),cases=[['null','null',null,400],['plain-limit',Buffer.alloc(32*1024*1024+1),null,413],['gzip-expansion',gzipSync(Buffer.alloc(32*1024*1024+1)),'gzip',413],['broken-gzip',Buffer.from('invalid'),'gzip',400],['unsupported','{}','br',415]],results=[]
 for(const[name,body,encoding,status]of cases){const r=await fetch(url,{method:'POST',headers:{...headers,...(encoding?{'content-encoding':encoding}:{})},body});const payload=await r.json();assert.equal(r.status,status);results.push({name,status:r.status,error:payload.error})}
 const after=await fetch(url,{headers}).then(r=>r.json());assert.deepEqual(after,before)
 console.log(JSON.stringify({passed:true,unchanged:true,results}))
})().catch(e=>{console.error(e);process.exitCode=1})
