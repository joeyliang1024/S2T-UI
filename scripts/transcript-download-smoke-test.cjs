const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/app/services/transcript-documents.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('transcript-download-smoke-module')
loaded.filename = 'transcript-download-smoke-module.cjs'; loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { transcriptBlob, transcriptDownloadFormats, transcriptFilename } = loaded.exports

const entries = [
  { id: 'a', revision: 1, status: 'final', startMs: 1_250, endMs: 3_500, speaker: 'NT-001', sourceText: 'A < B & C', translatedText: 'Translated' },
  { id: 'b', revision: 1, status: 'final', startMs: 6_000, endMs: 8_000, sourceText: '第二段' },
  { id: 'gap', revision: 1, status: 'gap', startMs: 9_000, endMs: 9_500, sourceText: '', gapReason: 'request-failed' }
]

const read = async (blob) => Buffer.from(await blob.arrayBuffer())
const zipSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const assertZip = (bytes, members) => {
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'container must be a zip')
  assert.ok(bytes.includes(zipSignature), 'zip must carry an end-of-central-directory record')
  for (const member of members) assert.ok(bytes.includes(Buffer.from(member, 'latin1')), `${member} must be inside the archive`)
}

const run = async () => {
  assert.deepEqual([...transcriptDownloadFormats], ['docx', 'xlsx', 'csv', 'txt', 'vtt'])
  assert.equal(transcriptFilename('meeting', 'docx'), 'meeting.docx')

  assertZip(await read(await transcriptBlob(entries, 'meeting', 'docx')), ['[Content_Types].xml', 'word/document.xml'])
  assertZip(await read(await transcriptBlob(entries, 'meeting', 'xlsx')), ['[Content_Types].xml', 'xl/workbook.xml'])

  const csv = (await read(await transcriptBlob(entries, 'meeting', 'csv'))).toString('utf8')
  assert.ok(csv.startsWith('﻿start_ms,end_ms'))
  assert.match(csv, /"NT-001"/)
  // CSV keeps the gap row so reviewers can tell missing audio from silence.
  assert.match(csv, /request-failed/)

  const txt = (await read(await transcriptBlob(entries, 'meeting', 'txt'))).toString('utf8')
  assert.match(txt, /\[00:01\] NT-001：A < B & C/)
  assert.match(txt, /Translated/)
  assert.doesNotMatch(txt, /request-failed/)

  const vtt = (await read(await transcriptBlob(entries, 'meeting', 'vtt'))).toString('utf8')
  assert.match(vtt, /^WEBVTT/)
  assert.doesNotMatch(vtt, /request-failed/)

  // Records from before timeline support still export their plain transcript.
  const legacyTxt = await read(await transcriptBlob([], 'legacy', 'txt', 'legacy transcript'))
  assert.equal(legacyTxt.toString('utf8'), 'legacy transcript')
  assert.equal(await transcriptBlob([], 'legacy', 'docx'), null)
  assert.equal(await transcriptBlob([], 'legacy', 'xlsx'), null)
  assert.equal(await transcriptBlob([], 'legacy', 'vtt'), null)
  console.log('Transcript download smoke test passed.')
}

run().catch((error) => { console.error(error); process.exit(1) })
