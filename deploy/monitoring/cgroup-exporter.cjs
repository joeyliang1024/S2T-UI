// Read-only cgroup v2 collector for Docker runtimes whose kubelet omits CFS metrics.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http')
const parse=value=>Object.fromEntries(value.trim().split('\n').map(line=>line.trim().split(/\s+/)).map(([key,v])=>[key,Number(v)]))
async function collect(root='/host-cgroup/kubepods') {
 const pods=[]
 async function scan(directory,depth=0) {
  if(depth>3)return
  let entries;try{entries=await fs.readdir(directory,{withFileTypes:true})}catch{return}
  for(const entry of entries){if(!entry.isDirectory())continue
   const folder=path.join(directory,entry.name),match=/^pod([a-f0-9-]+)$/.exec(entry.name)
   if(!match){await scan(folder,depth+1);continue}
   let periods=0,throttled=0,seconds=0,available=false
   for(const child of await fs.readdir(folder,{withFileTypes:true})){
    if(!child.isDirectory()||!/^[a-f0-9]{64}$/.test(child.name))continue
    try{const values=parse(await fs.readFile(path.join(folder,child.name,'cpu.stat'),'utf8'))
     if(!Number.isFinite(values.nr_periods)||!Number.isFinite(values.nr_throttled))continue
     available=true;periods+=values.nr_periods;throttled+=values.nr_throttled;seconds+=(values.throttled_usec||0)/1e6
    }catch{}
   }
   if(available)pods.push({uid:match[1],periods,throttled,seconds})
  }
 }
 await scan(root)
 return pods
}
async function render(root){const pods=await collect(root),lines=['# TYPE s2t_cgroup_cpu_periods_total counter','# TYPE s2t_cgroup_cpu_throttled_periods_total counter','# TYPE s2t_cgroup_cpu_throttled_seconds_total counter']
 for(const p of pods)lines.push(`s2t_cgroup_cpu_periods_total{uid="${p.uid}"} ${p.periods}`,`s2t_cgroup_cpu_throttled_periods_total{uid="${p.uid}"} ${p.throttled}`,`s2t_cgroup_cpu_throttled_seconds_total{uid="${p.uid}"} ${p.seconds}`)
 return lines.join('\n')+'\n'
}
if(require.main===module)http.createServer(async(req,res)=>{if(req.url!='/metrics'){res.writeHead(404);return res.end()}try{res.writeHead(200,{'content-type':'text/plain; version=0.0.4'});res.end(await render())}catch{res.writeHead(503);res.end()}}).listen(9108,'0.0.0.0')
module.exports={parse,collect,render}
