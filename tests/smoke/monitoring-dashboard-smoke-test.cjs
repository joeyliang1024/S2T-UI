const assert = require('node:assert/strict')
const fs = require('node:fs')
const read = file => JSON.parse(fs.readFileSync(`deploy/monitoring/${file}`, 'utf8'))
const detail = read('dashboard.json'), oncall = read('oncall.json'), stack = read('stack.json')
const embedded = stack.items.find(item => item.kind === 'ConfigMap' && item.metadata.name === 's2t-dashboard').data
for (const dashboard of [detail, oncall]) {
  assert.equal(new Set(dashboard.panels.map(p => p.id)).size, dashboard.panels.length, 'panel ids must be unique')
  const panels = dashboard.panels.filter(p => p.type !== 'row')
  for (const [i, a] of panels.entries()) {
    const g = a.gridPos
    assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.w <= 24 && g.h > 0)
    for (const b of panels.slice(i + 1)) {
      const h = b.gridPos
      assert.ok(!(g.x < h.x + h.w && h.x < g.x + g.w && g.y < h.y + h.h && h.y < g.y + g.h), `${a.title} overlaps ${b.title}`)
    }
  }
  const byId = Object.fromEntries(panels.map(p => [p.id, p]))
  assert.deepEqual(panels.filter(p => p.gridPos.y === 1).map(p => p.id), [2, 3, 4], 'three top KPI cards')
  for (const [id, stage] of [[2, 'e2e_translation_tail'], [3, 'e2e_asr']]) {
    assert.equal(byId[id].type, 'stat')
    assert.ok(byId[id].targets[0].expr.includes(`stage="${stage}"`))
    assert.ok(byId[id].targets[0].expr.includes('histogram_quantile(0.90'))
  }
  for (const id of [6, 52]) {
    assert.equal(byId[id].options.orientation, 'horizontal')
    assert.ok(byId[id].targets[0].expr.endsWith(' > 0)'), 'unexecuted stages must not divide by zero and show NaN')
  }
  assert.ok(byId[6].targets[0].expr.includes('phase=~"t[1-7]"'))
  assert.ok(byId[52].targets[0].expr.includes('stage!="t2_segment"'), 'speech accumulation must be excluded from VAD details')
  for (const id of [47, 48, 49, 50]) {
    const expr = byId[id].targets[0].expr
    assert.ok(expr.includes('topk(10'))
    assert.ok(expr.includes('user_id!="__overflow__"'))
    assert.ok(expr.includes('${usage_department:regex}'))
    if ([49, 50].includes(id)) assert.ok(expr.includes('${usage_user:regex}'))
  }
}
assert.equal(detail.panels.find(p => p.id === 7).type, 'piechart')
for (const file of ['dashboard.json', 'oncall.json']) assert.deepEqual(JSON.parse(embedded[file]), read(file), 'provisioning must match tracked dashboard')
console.log('PASS monitoring: three P90/success KPIs, phase/detail separation, VAD exclusion, pie chart, four filtered Top 10 rankings, valid layout and provisioning parity')
