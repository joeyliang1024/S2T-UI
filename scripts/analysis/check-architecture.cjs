const graph = require('./code-graph.cjs')
const problems = [...graph.violations.map(edge => `${edge.from}:${edge.line} depends on ${edge.to}`), ...graph.runtimeCycles.map(cycle => `Runtime cycle: ${cycle.join(' -> ')}`)]
for (const item of graph.unresolved) if (!/\.(css|svg|png|html)$/.test(item.spec)) problems.push(`Unresolved import: ${item.from} -> ${item.spec}`)
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1 }
else console.log(`PASS architecture: ${graph.nodeCount} modules, no runtime cycles or reverse shared/server dependencies`)
