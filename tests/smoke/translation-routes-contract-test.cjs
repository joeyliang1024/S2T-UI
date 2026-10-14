const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createTranslationService, createTranslationPrompt } = require('../../server/services/translation.cjs')
const { createTranslationRoutes } = require('../../server/http/routes/translations.cjs')

const readBody = (request, maximum) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  request.on('data', chunk => { size += chunk.length; if (size > maximum) reject(Object.assign(new Error('too large'), { status: 413 })); else chunks.push(chunk) })
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', reject)
})
const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
const validateAdminParameters = ({ translationTemperature }) => {
  if (typeof translationTemperature !== 'number' || translationTemperature < 0 || translationTemperature > 2) throw Error('translationTemperature 必須介於 0 與 2')
  return { translationTemperature }
}

;(async () => {
  const markdownPrompt = createTranslationPrompt('# 標題\n\n- 項目\n\n```js\nconst x = 1\n```', 'zh-CN', 'en', '專有名詞 = Term', 'markdown')
  assert.match(markdownPrompt, /简体中文/)
  assert.match(markdownPrompt, /保留标题、列表、表格与代码块/)
  assert.match(markdownPrompt, /```js/)

  let currentUser = { id: 'u1', role: 'admin' }
  let limited = { accepted: true }
  let captured
  let providerError
  const logs = []
  const service = createTranslationService({
    completeText: async (...args) => {
      captured = args
      if (providerError) throw providerError
      return '# Translation\n\n- item'
    },
    measure: async (_name, action) => action(),
    withCapacity: async (_bucket, action) => action(),
    logger: { debug: (...args) => logs.push(args) },
    now: () => 100
  })
  const route = createTranslationRoutes({
    translation: { endpoint: 'https://translation.example/v1', model: 'translate', apiKey: 'secret' },
    accountModelService: async () => ({ endpoint: 'https://account.example/v1', model: 'account-translate', apiKey: '' }),
    acceptsRequest: async () => limited,
    rateLimitResponse: (response, result, message) => { response.setHeader('retry-after', String(result.retryAfterSeconds)); send(response, 429, { error: message, retryAfterSeconds: result.retryAfterSeconds }) },
    readBody,
    send,
    storage: { config: { get: async () => ({ settings: { adminParameters: { translationTemperature: 0.4 } } }) } },
    validateAdminParameters,
    executeIdempotent: async (_config, _userId, _path, _key, _hash, operation) => operation(),
    requestHash: value => `hash:${value}`,
    translationService: service,
    upstreamRateLimit: error => error?.rateLimit,
    serverTimingHeader: timing => Object.keys(timing).join(','),
    logger: { debug: (...args) => logs.push(args) },
    now: () => 100
  })
  const auth = { requireUser: async request => { request.s2tUserId = currentUser?.id; return currentUser } }
  const server = createServer((request, response) => void route(request, response, auth).catch(error => { response.statusCode = 500; response.end(error.stack) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const request = async (body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/translations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { response, body: await response.json() }
  }
  try {
    let result = await request({ text: '# 原文\n\n- 項目', sourceLanguage: 'zh-CN', targetLanguage: 'en', glossary: '項目 = item', format: 'markdown' })
    assert.equal(result.response.status, 200)
    assert.equal(result.body.text, '# Translation\n\n- item')
    assert.match(captured[1][0].content, /来源语言为简体中文/)
    assert.match(captured[1][0].content, /保留标题、列表、表格与代码块/)
    assert.equal(captured[2], 0, 'translation keeps single provider attempt')
    assert.equal(captured[3], 0.4, 'admin settings temperature is preserved')
    assert.deepEqual(captured[4], { userId: 'u1', operation: 'translations' })
    assert.equal(result.response.headers.get('server-timing'), 'total,model,queue')

    currentUser = { id: 'u2', role: 'user' }
    result = await request({ text: 'hello', temperature: 0.7 })
    assert.equal(result.response.status, 403)
    currentUser = null
    result = await request({ text: 'hello' })
    assert.equal(result.response.status, 401)
    currentUser = { id: 'u1', role: 'admin' }
    limited = { accepted: false, retryAfterSeconds: 3 }
    result = await request({ text: 'hello' })
    assert.equal(result.response.status, 429)
    assert.equal(result.response.headers.get('retry-after'), '3')
    limited = { accepted: true }
    providerError = Object.assign(new Error('provider timeout'), { status: 503 })
    result = await request({ text: 'hello' })
    assert.equal(result.response.status, 503)
    assert.equal(result.body.error, 'provider timeout')
    providerError = Object.assign(new Error('provider throttled'), { rateLimit: { retryAfterSeconds: 9 } })
    result = await request({ text: 'hello' })
    assert.equal(result.response.status, 429)
    assert.equal(result.response.headers.get('retry-after'), '9')
    console.log('PASS translation route contract: Markdown/zh-CN prompt, auth, admin temperature, rate limits, provider timeout and upstream throttling')
  } finally { await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
