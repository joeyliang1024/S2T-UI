const { existsSync, copyFileSync, chmodSync, readFileSync } = require('node:fs')
const { resolve, dirname, join } = require('node:path')
const { createHash } = require('node:crypto')
const target = require('ffmpeg-static')
if (!target) throw new Error(`Unsupported ffmpeg platform: ${process.platform}/${process.arch}`)
if (existsSync(target)) { console.log('ffmpeg runtime already available'); process.exit(0) }
const root = resolve(__dirname, '../..')
const hashes = { x64: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99', arm64: '115a825e246078acf820ea2afcaf1b3ff87f1b93f7035ecad38d3223cca55297' }
const source = process.env.S2T_TEST_FFMPEG_SOURCE || (process.platform === 'linux' && hashes[process.arch] ? join(root, 'dependencies/ffmpeg-static', `ffmpeg-linux-${process.arch}`) : '')
if (!source || !existsSync(source)) throw new Error('Provide S2T_TEST_FFMPEG_SOURCE on non-Linux systems, or install the ffmpeg-static runtime using your approved dependency setup.')
if (!process.env.S2T_TEST_FFMPEG_SOURCE && createHash('sha256').update(readFileSync(source)).digest('hex') !== hashes[process.arch]) throw new Error('Vendored ffmpeg checksum mismatch')
copyFileSync(source, target); chmodSync(target, 0o755)
console.log(`Prepared ffmpeg for ${process.platform}/${process.arch}`)
