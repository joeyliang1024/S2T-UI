// Isolated Docker check: actual Nginx keepalive, byte forwarding and DNS refresh.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readEnv } = require('../../scripts/runtime.cjs')
if (process.env.S2T_ALLOW_DEPLOYMENT_TESTS !== 'true') throw Error('Explicit deployment test opt-in required')
const context = process.env.S2T_DOCKER_CONTEXT || 'colima-s2t-stress'
const image = process.env.S2T_PROXY_TEST_IMAGE || readEnv('deploy/k8s/.env').FRONTEND_IMAGE
if (!image) throw Error('Frontend image required')
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 60000, stdio: ['ignore','pipe','pipe'] })
const stamp = Date.now().toString(36), network = 's2t-proxy-' + stamp
const backend = network + '-backend', replacement = backend + '-replacement', frontend = network + '-frontend'
const source = `const http=require('http');let sequence=0;const ids=new WeakMap();const server=http.createServer(async(req,res)=>{let bytes=0;for await(const chunk of req)bytes+=chunk.length;res.setHeader('content-type','application/json');res.end(JSON.stringify({connection:ids.get(req.socket),url:req.url,method:req.method,bytes}))});server.keepAliveTimeout=15000;server.on('connection',socket=>ids.set(socket,++sequence));server.listen(8787,'0.0.0.0')`
try {
  docker('network', 'create', network)
  docker('run', '-d', '--rm', '--name', backend, '--network', network, 'node:22-alpine', 'node', '-e', source)
  docker('run', '-d', '--rm', '--name', frontend, '--network', network, '-e', 'BACKEND_UPSTREAM=http://' + backend + ':8787', '-e', 'DNS_RESOLVER=127.0.0.11', image)
  const result = docker('run', '--rm', '--network', network, 'node:22-alpine', 'node', '-e', `
(async()=>{const base='http://${frontend}:5173';let ready=false;for(let i=0;i<50;i++){try{const r=await fetch(base+'/livez');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}if(!ready)throw Error('Nginx not ready');const rows=[];for(let i=0;i<30;i++){const r=await fetch(base+'/api/keep%2Fencoded?q=%2F%20');if(!r.ok)throw Error('Proxy HTTP '+r.status);rows.push(await r.json())}const put=await fetch(base+'/api/upload',{method:'PUT',body:Buffer.alloc(65536,7)});if(!put.ok)throw Error('Upload failed');console.log(JSON.stringify({rows,put:await put.json()}))})().catch(e=>{console.error(e.message);process.exitCode=1})`)
  const value = JSON.parse(result)
  assert.ok(new Set(value.rows.map(row => row.connection)).size <= 4, 'Sequential requests must reuse upstream sockets')
  for (const row of value.rows) assert.equal(row.url, '/api/keep%2Fencoded?q=%2F%20')
  assert.equal(value.put.bytes, 65536)
  assert.equal(value.put.method, 'PUT')
  const oldIp = JSON.parse(docker('inspect', backend))[0].NetworkSettings.Networks[network].IPAddress
  docker('run', '-d', '--rm', '--name', replacement, '--network', network, '--network-alias', backend, 'node:22-alpine', 'node', '-e', source)
  const newIp = JSON.parse(docker('inspect', replacement))[0].NetworkSettings.Networks[network].IPAddress
  assert.notEqual(newIp, oldIp, 'Replacement must have a different address')
  docker('rm', '-f', backend)
  docker('run', '--rm', '--network', network, 'node:22-alpine', 'node', '-e', `
(async()=>{for(let i=0;i<100;i++){try{const r=await fetch('http://${frontend}:5173/api/replaced');if(r.ok){const body=await r.json();if(body.url==='/api/replaced'){console.log('DNS refreshed');return}}}catch{}await new Promise(r=>setTimeout(r,250))}throw Error('Replacement never recovered')})().catch(e=>{console.error(e.message);process.exitCode=1})`)
  console.log('PASS actual Nginx: bounded upstream keepalive reuse, encoded URI preservation, full upload and backend replacement recovery')
} finally {
  for (const name of [frontend, backend, replacement]) { try { docker('rm', '-f', name) } catch {} }
  try { docker('network', 'rm', network) } catch {}
}
