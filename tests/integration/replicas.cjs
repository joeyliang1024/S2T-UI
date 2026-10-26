const assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process'),{createServer}=require('node:net'),{request}=require('playwright'),{readEnv}=require('../../scripts/runtime.cjs')
if(process.env.S2T_ALLOW_DEPLOYMENT_TESTS!=='true')throw Error('Explicit local deployment test opt-in required')
const config={...readEnv('deploy/k8s/.env'),...process.env},env=readEnv('backend/.env.k8s'),k=[...(config.K8S_CONTEXT?['--context',config.K8S_CONTEXT]:[]),'-n',config.K8S_NAMESPACE||'s2t-web']
const free=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
;(async()=>{const children=[],contexts=[];let adminToken,id
try{
 const pods=JSON.parse(execFileSync('kubectl',[...k,'get','pods','-l','app=s2t-backend','-o','json'],{encoding:'utf8'})).items.filter(p=>!p.metadata.deletionTimestamp&&p.status.containerStatuses?.every(c=>c.ready));assert.equal(pods.length,2)
 const ports=await Promise.all([free(),free()])
 for(let i=0;i<2;i++){const child=spawn('kubectl',[...k,'port-forward','pod/'+pods[i].metadata.name,`${ports[i]}:8787`,'--address=127.0.0.1'],{stdio:['ignore','pipe','pipe']});children.push(child);await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('forward timeout')),15000);child.stdout.once('data',()=>{clearTimeout(t);r()});child.once('exit',()=>{clearTimeout(t);j(Error('forward exited'))})});contexts.push(await request.newContext({baseURL:`http://127.0.0.1:${ports[i]}`}))}
 const call=async(i,method,path,options={},expected=200)=>{const r=await contexts[i][method](path,options);assert.equal(r.status(),expected,`${method} ${path}: ${await r.text()}`);return r}
 const login=await(await call(0,'post','/api/auth/login',{data:{username:env.S2T_BOOTSTRAP_ADMIN_USERNAME,password:env.S2T_BOOTSTRAP_ADMIN_PASSWORD}})).json();adminToken=login.token
 const stamp=Date.now().toString(36),username='replica-'+stamp,password='Replica-check-'+stamp+'-password'
 id=(await(await call(0,'post','/api/admin/users',{headers:{authorization:'Bearer '+adminToken},data:{username,password,NT:username,Department:'Replica validation'}},201)).json()).user.id
 const user=await(await call(0,'post','/api/auth/login',{data:{username,password}})).json();const headers={authorization:'Bearer '+user.token}
 assert.equal((await(await call(1,'get','/api/auth/session',{headers})).json()).user.id,id)
 await call(0,'post','/api/data/settings',{headers,data:{settings:{theme:'dark'},version:0}})
 await call(1,'post','/api/data/settings',{headers,data:{settings:{theme:'light'},version:0}},409)
 assert.equal((await(await call(1,'get','/api/data/settings',{headers})).json()).settings.theme,'dark')
 const recording='replica-'+stamp
 for(const i of [0,1])await call(i,'put',`/api/data/recordings/${recording}/chunks/${i}`,{headers:{...headers,'x-s2t-start-sample':String(i*2),'x-s2t-sample-rate':'16000'},data:Buffer.from([i+1,0,i+2,0])})
 await call(1,'post',`/api/data/recordings/${recording}/finish`,{headers,data:{totalChunks:2,totalSamples:4}})
 assert.equal((await(await call(0,'get',`/api/data/audio/${recording}`,{headers})).body()).length,52)
 await call(0,'post','/api/auth/logout',{headers},204)
 await call(1,'get','/api/auth/session',{headers},401)
 console.log('PASS actual two Pods: cross-Pod JWT, single-winner CAS, chunk handoff/finish/read and shared logout revocation',pods.map(x=>x.metadata.name))
}finally{
 if(id&&adminToken&&contexts[0]){const r=await contexts[0].delete('/api/admin/users/'+id,{headers:{authorization:'Bearer '+adminToken}});assert.ok([200,204].includes(r.status()))}
 for(const c of contexts)await c.dispose();for(const c of children)c.kill('SIGTERM')
}})().catch(e=>{console.error(e.message);process.exitCode=1})
