const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {render}=require('../../deploy/monitoring/cgroup-exporter.cjs')
;(async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'cgroup-metrics-'))
try{const pod=path.join(root,'burstable','podabcdef01-2345-6789-abcd-abcdefabcdef')
for(const [i,values] of [[1,'nr_periods 20\nnr_throttled 2\nthrottled_usec 150000\n'],[2,'nr_periods 10\nnr_throttled 1\nthrottled_usec 50000\n']]){const dir=path.join(pod,String(i).repeat(64));await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'cpu.stat'),values)}
const output=await render(root);assert.match(output,/periods_total\{uid="abcdef01-2345-6789-abcd-abcdefabcdef"\} 30/);assert.match(output,/throttled_periods_total\{uid="abcdef01-2345-6789-abcd-abcdefabcdef"\} 3/);assert.match(output,/throttled_seconds_total\{uid="abcdef01-2345-6789-abcd-abcdefabcdef"\} 0.2/)
console.log('PASS cgroup v2 per-container aggregation, UID labels and microseconds conversion')
}finally{await fs.rm(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1})
