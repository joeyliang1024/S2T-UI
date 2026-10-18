const assert=require('node:assert/strict')
const {testModelApi,handleModelApiTest,validateDraft}=require('../../server/model-api-test.cjs')
const model={id:'saved',endpoint:'https://fixture.invalid/v1',model:'fixture-model',purpose:'translation',requiresApiKey:true}
let requests=[],keyReads=0
const deps={auth:{},user:{id:'owner'},storage:{config:{get:async(user,key)=>{assert.equal(user,'owner');assert.equal(key,'model-registry');return {models:[model]}}}},configuredAsrProfiles:[],translation:{},summary:{},diarization:{},localDiarizationProfiles:()=>[],localModelName:()=> 'local',accountModelService:async(_auth,user,id)=>{assert.equal(user.id,'owner');assert.equal(id,'saved');keyReads++;return {...model,apiKey:'stored-private-key'}},baseUrl:endpoint=>endpoint, sileroHealth:async m=>({id:m.id,state:'healthy',reason:'local VAD',checkedAt:Date.now()}),sherpaHealth:async m=>({id:m.id,state:'healthy',reason:'local worker',checkedAt:Date.now()})}
const original=global.fetch
;(async()=>{
 global.fetch=async(url,options)=>{requests.push({url,options});return Response.json({data:[{id:'fixture-model'}]})}
 const first=await testModelApi({id:'saved'},deps)
 assert.equal(first.state,'healthy');assert.equal(first.testKind,'model-list');assert.ok(first.elapsedMs>=0)
 assert.equal(requests[0].options.headers.authorization,'Bearer stored-private-key')
 await testModelApi({id:'saved'},deps);assert.equal(requests.length,2,'manual calls bypass cache')
 const before=requests.length,reads=keyReads
 const changed=await testModelApi({...model,endpoint:'https://different.invalid/v1'},deps)
 assert.equal(changed.state,'unknown');assert.equal(requests.length,before);assert.equal(keyReads,reads,'changed destination must not reuse stored credentials')
 await testModelApi({...model,endpoint:'https://different.invalid/v1',apiKey:'temporary-draft-key'},deps)
 assert.equal(requests.at(-1).options.headers.authorization,'Bearer temporary-draft-key');assert.equal(keyReads,reads)
 await testModelApi({...model,requiresApiKey:false,apiKey:'ignored-stale-key'},deps);assert.deepEqual(requests.at(-1).options.headers,{})
 const override={...deps,accountModelService:async()=>{throw Error('decryption failed')}}
 assert.equal((await testModelApi({...model,apiKey:'replacement-key'},override)).state,'healthy','a replacement key does not depend on decrypting the old key')
 assert.equal((await testModelApi({...model,endpoint:'/api/audio-processing/silero-vad',requiresApiKey:false},deps)).testKind,'local-runtime')
 assert.equal((await testModelApi({...model,endpoint:'wss://fixture.invalid/asr',apiKey:'test-key'},deps)).state,'unknown','unsupported websocket is not marked healthy')
 await assert.rejects(testModelApi({id:'foreign'},deps),error=>error.status===404)
 for(const endpoint of ['file:///etc/passwd','https://name:secret@fixture.invalid/v1','bad-url'])assert.throws(()=>validateDraft({...model,endpoint}),error=>error.status===400)
 assert.throws(()=>validateDraft({...model,apiKey:42}),error=>error.status===400)
 global.fetch=async()=>Response.json({error:{message:'stored-private-key Bearer leaked-secret'}},{status:401})
 const failure=await testModelApi({id:'saved'},deps)
 assert.equal(failure.state,'unhealthy');assert.ok(!failure.reason.includes('stored-private-key')&&!failure.reason.includes('leaked-secret'))
 let response
 await handleModelApiTest({}, {}, {...deps,auth:{requireUser:async()=>null},send:(_r,status,body)=>{response={status,body}}})
 assert.equal(response.status,401)
 await handleModelApiTest({}, {}, {...deps,auth:{requireUser:async()=>deps.user},acceptsRequest:async()=>({accepted:true}),readBody:async()=>Buffer.from(JSON.stringify({...model,apiKey:'must-not-save'})),send:(_r,status,body)=>{response={status,body}}})
 assert.equal(response.status,200);assert.equal(response.body.result.state,'unhealthy');assert.ok(!JSON.stringify(response).includes('must-not-save'))
 console.log('PASS manual API tests: uncached saved/draft tests, transient keys, destination isolation, replacement keys, local runtime, unsupported websocket, auth, validation and redaction')
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{global.fetch=original})
