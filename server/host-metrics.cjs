const { readFile } = require('node:fs/promises')
const os = require('node:os')
let cached = '', sampledAt = 0, refreshing = false
const refresh = async () => {
  if (refreshing) return
  refreshing = true
  try {
    const lines = []
    for (const [resource,text] of await Promise.all(['cpu','io'].map(async resource => [resource,await readFile(`/proc/pressure/${resource}`,'utf8').catch(()=>null)]))) {
      if (!text) continue
      for (const line of text.trim().split('\n')) {
        const [kind,...fields] = line.split(/\s+/)
        if (!['some','full'].includes(kind)) continue
        for (const field of fields) {
          const [key,raw] = field.split('='), value = Number(raw)
          if (!Number.isFinite(value) || value < 0) continue
          if (['avg10','avg60','avg300'].includes(key)) lines.push(`s2t_host_pressure_ratio{resource="${resource}",kind="${kind}",window="${key.slice(3)}s"} ${value/100}`)
          if (key === 'total') lines.push(`s2t_host_pressure_stall_seconds_total{resource="${resource}",kind="${kind}"} ${value/1e6}`)
        }
      }
    }
    // On platforms without PSI these series stay absent, never fake zeroes.
    cached = lines.length ? '# TYPE s2t_host_pressure_ratio gauge\n# TYPE s2t_host_pressure_stall_seconds_total counter\n'+lines.join('\n')+'\n' : ''
    sampledAt = Date.now()
  } finally { refreshing = false }
}
const timer = setInterval(()=>{void refresh()},5000);timer.unref()
void refresh()
const render = () => cached + (cached ? `s2t_host_pressure_snapshot_age_seconds ${(Date.now()-sampledAt)/1000}\n` : '') + `s2t_host_cpu_cores ${os.availableParallelism()}\n` + os.loadavg().map((value,index)=>`s2t_host_load_average{window="${[1,5,15][index]}m"} ${value}\n`).join('')
module.exports = { render }
