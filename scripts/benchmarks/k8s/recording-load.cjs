// Run the recording/model workload inside an explicitly selected test cluster.
// Credentials are mounted as a Secret and are never written to logs/reports.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { readEnv } = require('../../runtime.cjs')
if (process.env.S2T_ALLOW_DEPLOYMENT_TESTS !== 'true') throw Error('Set S2T_ALLOW_DEPLOYMENT_TESTS=true for an isolated test deployment')
const env = { ...readEnv('deploy/k8s/.env'), ...process.env }
if (!env.K8S_CONTEXT || !env.K8S_NAMESPACE) throw Error('Explicit K8S_CONTEXT and K8S_NAMESPACE required')
const name = env.LOAD_POD || 's2t-recording-' + Date.now().toString(36)
if (!/^s2t-recording-[a-z0-9-]{1,45}$/.test(name)) throw Error('Invalid load Pod name')
const k = ['--context', env.K8S_CONTEXT, '-n', env.K8S_NAMESPACE]
const kubectl = args => execFileSync('kubectl', [...k, ...args], { encoding: 'utf8' })
const mode = process.argv[2] || 'start'
if (mode === 'collect') {
  const report = JSON.parse(kubectl(['exec', name, '--', 'cat', '/results/report.json']))
  const target = env.S2T_LOAD_REPORT || path.join('/tmp', name + '.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: target, passed: report.passed }))
} else if (mode === 'cleanup') {
  // This removes the test runner and its credentials, never application data.
  console.log(kubectl(['delete', 'pod/' + name, 'configmap/' + name + '-code', 'secret/' + name + '-credentials', '--ignore-not-found']))
} else if (mode === 'start') {
  const tokensPath = env.S2T_LOAD_TOKENS_FILE
  if (!tokensPath) throw Error('S2T_LOAD_TOKENS_FILE is required')
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'))
  const users = Number(env.S2T_LOAD_CONCURRENCY || 500)
  const seconds = Number(env.LOAD_SECONDS || 600)
  const cadence = Number(env.LOAD_CADENCE_MS || 2000)
  if (!Number.isInteger(users) || users < 1 || users > 500 || tokens.length < users || new Set(tokens.slice(0, users)).size !== users) throw Error('Distinct credentials required')
  if (!Number.isInteger(seconds) || seconds < 2 || !Number.isInteger(cadence) || cadence < 1000 || cadence > 10000 || seconds * 1000 % cadence) throw Error('Invalid duration/cadence')
  const supervisor = `const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['/perf/load.cjs'],{stdio:'inherit'});
child.on('exit',(code,signal)=>{
 fs.writeFileSync('/results/exit-code',JSON.stringify({code,signal}));
 if(!fs.existsSync('/results/report.json'))fs.writeFileSync('/results/report.json',JSON.stringify({passed:false,complete:false,reason:'Load generator exited without report',code,signal}));
 setInterval(()=>{},60000);
});`
  const items = [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: name + '-code' }, data: { 'load.cjs': fs.readFileSync(path.resolve(__dirname, '../recording-load.cjs'), 'utf8') } },
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: name + '-credentials' }, type: 'Opaque', stringData: { 'tokens.json': JSON.stringify(tokens.slice(0, users)) } },
    { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels: { app: 's2t-recording-load' } }, spec: {
      restartPolicy: 'Never', containers: [{ name: 'load', image: env.S2T_LOAD_IMAGE || 'node:22-alpine', command: ['node', '-e', supervisor],
        env: [
          { name: 'S2T_LOAD_BASE_URL', value: 'http://s2t-frontend:5173' },
          { name: 'S2T_LOAD_TOKENS_FILE', value: '/credentials/tokens.json' },
          { name: 'S2T_LOAD_CONCURRENCY', value: String(users) },
          { name: 'S2T_LOAD_CADENCE_MS', value: String(cadence) },
          { name: 'S2T_LOAD_DURATION_SECONDS', value: String(seconds) },
          { name: 'S2T_LOAD_START_AT', value: env.S2T_LOAD_START_AT || '0' },
          { name: 'S2T_LOAD_REPORT', value: '/results/report.json' }
        ], resources: { requests: { cpu: '500m', memory: '256Mi' }, limits: { memory: '2Gi' } },
        volumeMounts: [{ name: 'code', mountPath: '/perf', readOnly: true }, { name: 'credentials', mountPath: '/credentials', readOnly: true }, { name: 'results', mountPath: '/results' }]
      }], volumes: [{ name: 'code', configMap: { name: name + '-code' } }, { name: 'credentials', secret: { secretName: name + '-credentials' } }, { name: 'results', emptyDir: {} }]
    } }
  ]
  execFileSync('kubectl', [...k, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }), stdio: ['pipe', 'inherit', 'inherit'] })
} else throw Error('Use start, collect or cleanup')
