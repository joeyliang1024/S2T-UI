const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const FILE_PREFIX = 'file-summary-'
const DEFAULT_NAMES = new Set(['會議摘要', '会议摘要', 'Meeting summary', '会議要約', 'Besprechungszusammenfassung'])
const DEFAULT_CONTENT = '# 會議摘要\n\n## 重點\n\n## 決策\n\n## 待辦事項\n'
const loadFileTemplates = async (directory = process.env.S2T_SUMMARY_TEMPLATES_DIR || '/data/template') => {
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const names = entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && /\.(md|markdown)$/i.test(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'en'))
  const realDirectory = await fs.realpath(directory)
  const templates = []
  for (const name of names) {
    const displayName = name.replace(/\.(md|markdown)$/i, '').trim().slice(0, 100)
    if (!displayName) continue
    let filename = path.join(directory, name)
    const metadata = await fs.lstat(filename)
    if (metadata.isSymbolicLink()) {
      // Kubernetes ConfigMap projected files use ..data/ links inside this directory.
      if (!(await fs.readlink(filename)).startsWith('..data/')) continue
      filename = await fs.realpath(filename)
      const relative = path.relative(realDirectory, filename)
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue
    }
    const file = await fs.open(filename, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) continue
      if (stat.size > 80000) throw new Error(`摘要模板 ${name} 過大（上限 20,000 字元）`)
      const content = await file.readFile('utf8')
      if (!content.trim()) continue
      if (content.length > 20000) throw new Error(`摘要模板 ${name} 過大（上限 20,000 字元）`)
      if (templates.length >= 100) throw new Error('摘要模板資料夾最多支援 100 個 Markdown 檔案')
      templates.push({ id: FILE_PREFIX + createHash('sha256').update(name).digest('hex').slice(0, 24), name: displayName, content, sourceFile: name })
    } finally { await file.close() }
  }
  return templates
}
const mergeTemplateSources = (personal, files) => [...files, ...(personal || []).filter(template => template && typeof template.id === 'string' && typeof template.name === 'string' && typeof template.content === 'string' && !template.id?.startsWith(FILE_PREFIX) && !(files.length && template.id === 'default-summary' && DEFAULT_NAMES.has(template.name) && template.content?.trim() === DEFAULT_CONTENT.trim()))]
module.exports = { FILE_PREFIX, loadFileTemplates, mergeTemplateSources }
