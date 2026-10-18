const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const source = path.join(root, 'docs/wiki')
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
const links = []
function check() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(manifest.repository) || !/^[a-f0-9]{40}$/.test(manifest.reviewedSourceCommit)) throw Error('Invalid Wiki manifest repository/commit')
  const names = new Set(manifest.pages)
  if (names.size !== manifest.pages.length || !['Home.md', '_Sidebar.md', '_Footer.md'].every(name => names.has(name))) throw Error('Missing or duplicate Wiki pages')
  for (const name of names) {
    if (!/^[\w-]+\.md$/.test(name)) throw Error(`Invalid managed page: ${name}`)
    const text = fs.readFileSync(path.join(source, name), 'utf8')
    const content = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
    for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const href = match[1]
      if (href.startsWith('#')) continue
      if (/^https?:/.test(href)) {
        const prefix = `https://github.com/${manifest.repository}/blob/${manifest.sourceRef}/`
        if (href.startsWith(prefix)) {
          const relative = decodeURIComponent(href.slice(prefix.length).split('#')[0])
          if (!fs.existsSync(path.join(root, relative))) throw Error(`${name}: missing repo path ${relative}`)
          links.push({ name, relative })
        }
        continue
      }
      const target = decodeURIComponent(href.split('#')[0]).replace(/\.md$/, '') + '.md'
      if (!names.has(target)) throw Error(`${name}: unknown Wiki link ${href}`)
    }
  }
  console.log(`PASS Wiki: ${names.size} managed pages, internal links and ${links.length} repo links`)
}
function publish() {
  const tree = JSON.parse(run('gh', ['api', `repos/${manifest.repository}/git/trees/${encodeURIComponent(manifest.sourceRef)}?recursive=1`]))
  if (tree.truncated || tree.sha !== manifest.reviewedSourceCommit) throw Error('Remote source changed or is incomplete; review content and update manifest before publishing')
  const remotePaths = new Set(tree.tree.map(item => item.path))
  for (const link of links) if (!remotePaths.has(link.relative)) throw Error(`${link.name}: repo path is not published on ${manifest.sourceRef}: ${link.relative}`)
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 's2t-wiki-'))
  const url = `https://github.com/${manifest.repository}.wiki.git`
  try {
    try { run('git', ['-c', 'credential.helper=!gh auth git-credential', 'clone', '--depth', '1', url, checkout]) }
    catch { throw Error(`Cannot clone Wiki. Verify access and initialize its first page at https://github.com/${manifest.repository}/wiki/_new; source pages are preserved in docs/wiki/.`) }
    const marker = '.s2t-wiki-source.json'
    const markerPath = path.join(checkout, marker)
    const previous = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null
    const adopt = process.argv.includes('--adopt-existing')
    for (const name of manifest.pages) {
      const destination = path.join(checkout, name)
      if (!fs.existsSync(destination)) continue
      const existing = fs.readFileSync(destination, 'utf8')
      const incoming = fs.readFileSync(path.join(source, name), 'utf8')
      if (existing === incoming) continue
      if (previous?.hashes?.[name] === hash(existing)) continue
      if (!adopt) throw Error(`Wiki ${name} has unreviewed remote edits. Review them before --adopt-existing; no page was overwritten.`)
    }
    for (const name of manifest.pages) fs.copyFileSync(path.join(source, name), path.join(checkout, name))
    const hashes = Object.fromEntries(manifest.pages.map(name => [name, hash(fs.readFileSync(path.join(source, name), 'utf8'))]))
    fs.writeFileSync(markerPath, JSON.stringify({ sourceRepository: manifest.repository, sourceRef: manifest.sourceRef, reviewedSourceCommit: manifest.reviewedSourceCommit, hashes }, null, 2) + '\n')
    run('git', ['add', '--', ...manifest.pages, marker], checkout)
    if (!run('git', ['diff', '--cached', '--name-only'], checkout).trim()) {
      console.log('Wiki already matches the source; nothing to publish')
      return
    }
    const user = JSON.parse(run('gh', ['api', 'user']))
    run('git', ['config', 'user.name', user.login], checkout)
    run('git', ['config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`], checkout)
    run('git', ['commit', '-m', 'docs: add development handbook and wiki navigation'], checkout)
    run('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', 'HEAD'], checkout)
    console.log(`Published ${run('git', ['rev-parse', 'HEAD'], checkout).trim()} to https://github.com/${manifest.repository}/wiki`)
  } finally { fs.rmSync(checkout, { recursive: true, force: true }) }
}
try {
  const mode = process.argv[2] || 'check'
  if (!['check', 'publish'].includes(mode)) throw Error('Usage: node scripts/docs/wiki.cjs check|publish [--adopt-existing]')
  check()
  if (mode === 'publish') publish()
} catch (error) { console.error(error.message); process.exitCode = 1 }
