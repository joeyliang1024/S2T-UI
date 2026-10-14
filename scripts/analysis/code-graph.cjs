const fs = require('node:fs'), path = require('node:path')
const root = path.resolve(__dirname, '../..')
const ts = require(path.join(root, 'node_modules/typescript'))
const files = []
function walk(dir) { for (const e of fs.readdirSync(path.join(root,dir), {withFileTypes:true})) {const f=path.posix.join(dir,e.name); if(e.isDirectory())walk(f);else if(/\.(?:tsx?|[cm]?js)$/.test(f)&&! /\.d\.(?:ts|cts)$/.test(f))files.push(f)} }
walk('src');walk('server')
const nodes=new Map(files.map(f=>[f,{file:f,lines:fs.readFileSync(path.join(root,f),'utf8').split('\n').length,imports:[],calls:0,functions:0,hooks:0,platformBranches:0}]))
const edges=[],unresolved=[]
function resolve(from,spec) {if(!spec.startsWith('.')&&!spec.startsWith('@renderer/'))return null;const base=spec.startsWith('@renderer/')?path.join(root,'src/renderer/src',spec.slice(10)):path.resolve(root,path.dirname(from),spec);for(const p of [base,...['.ts','.tsx','.js','.cjs','.mjs','/index.ts','/index.tsx','/index.js','/index.cjs'].map(s=>base+s)]){const rel=path.relative(root,p);if(nodes.has(rel))return rel}return undefined}
for(const f of files){const source=fs.readFileSync(path.join(root,f),'utf8'),ast=ts.createSourceFile(f,source,ts.ScriptTarget.Latest,true),node=nodes.get(f)
function add(spec,pos,kind,typeOnly=false){const target=resolve(f,spec);if(target)edges.push({from:f,to:target,line:ast.getLineAndCharacterOfPosition(pos).line+1,kind,typeOnly});else if(target===undefined)unresolved.push({from:f,spec});node.imports.push(spec)}
function visit(n){if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier))add(n.moduleSpecifier.text,n.getStart(ast),'import',!!n.importClause?.isTypeOnly||!!(n.importClause&&!n.importClause.name&&n.importClause.namedBindings&&ts.isNamedImports(n.importClause.namedBindings)&&n.importClause.namedBindings.elements.every(x=>x.isTypeOnly)))
if(ts.isExportDeclaration(n)&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))add(n.moduleSpecifier.text,n.getStart(ast),'export',!!n.isTypeOnly)
if(ts.isCallExpression(n)){node.calls++;const name=n.expression.getText(ast);if(/^use(?:State|Ref|Effect|Callback|Memo)$/.test(name))node.hooks++;if((name==='require'||n.expression.kind===ts.SyntaxKind.ImportKeyword)&&n.arguments.length&&ts.isStringLiteral(n.arguments[0]))add(n.arguments[0].text,n.getStart(ast),name)}
if(ts.isFunctionDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isMethodDeclaration(n))node.functions++
if(ts.isPropertyAccessExpression(n)&&n.getText(ast)==='window.s2t')node.platformBranches++
ts.forEachChild(n,visit)}visit(ast)}
function graph(includeTypes){const adj=new Map(files.map(f=>[f,new Set()]));for(const e of edges)if(includeTypes||!e.typeOnly)adj.get(e.from).add(e.to);let clock=0;const index=new Map(),low=new Map(),stack=[],on=new Set(),components=[];function visit(v){index.set(v,clock);low.set(v,clock++);stack.push(v);on.add(v);for(const w of adj.get(v)){if(!index.has(w)){visit(w);low.set(v,Math.min(low.get(v),low.get(w)))}else if(on.has(w))low.set(v,Math.min(low.get(v),index.get(w)))}if(low.get(v)===index.get(v)){const c=[];let w;do{w=stack.pop();on.delete(w);c.push(w)}while(w!==v);if(c.length>1||adj.get(v).has(v))components.push(c)}}for(const f of files)if(!index.has(f))visit(f);return {adj,cycles:components}}
const all=graph(true),runtime=graph(false),incoming=new Map(files.map(f=>[f,new Set()]));for(const [from,tos]of all.adj)for(const to of tos)incoming.get(to).add(from)
const ranked=files.map(f=>({...nodes.get(f),imports:undefined,fanOut:all.adj.get(f).size,fanIn:incoming.get(f).size}));const top=(key)=>[...ranked].sort((a,b)=>b[key]-a[key]).slice(0,12)
const feature=f=>/^src\/renderer\/src\/features\/([^/]+)/.exec(f)?.[1],violations=edges.filter(e=>(e.from.startsWith('src/renderer/src/shared/')&&feature(e.to))||(e.from.startsWith('src/')&&e.to.startsWith('server/')))
const featureEdges={};for(const e of edges){const a=feature(e.from),b=feature(e.to);if(a&&b&&a!==b){const key=a+' -> '+b;featureEdges[key]=(featureEdges[key]||0)+1}}
const report={scope:['src','server'],nodeCount:files.length,edgeCount:edges.length,runtimeCycles:runtime.cycles,allCycles:all.cycles,topFanOut:top('fanOut'),topFanIn:top('fanIn'),topLines:top('lines'),violations,featureEdges,unresolved}
module.exports = { ...report, nodes: ranked, edges }
if (require.main === module) {
  const output = process.argv[2] || 'docs/reports/CODE_GRAPH_CURRENT.json'
  fs.writeFileSync(path.resolve(root, output), JSON.stringify(module.exports, null, 2))
  console.log(JSON.stringify({ files: report.nodeCount, edges: report.edgeCount, runtimeCycles: report.runtimeCycles, violations: report.violations, output }))
}
