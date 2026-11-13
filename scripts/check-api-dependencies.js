// Local-only compatibility checks for the SDK's dependency overrides. No cloud
// requests or credentials are used; the HTTP checks bind to loopback only.
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { createRequire } = require('node:module')
const apiRequire = createRequire(process.argv[2]
  ? path.resolve(process.argv[2], 'package.json')
  : path.resolve(__dirname, '../cloudfunctions/api/package.json'))

async function main() {
  const set = apiRequire('lodash.set')
  const unset = apiRequire('lodash.unset')
  const sample = {}
  assert.equal(typeof set.default, 'function')
  assert.equal(typeof unset.default, 'function')
  set.default(sample, 'pets[0].name', '小白')
  assert.equal(sample.pets[0].name, '小白')
  assert.equal(unset.default(sample, 'pets[0].name'), true)
  assert.deepEqual(sample, { pets: [{}] })
  set(sample, ['constructor', 'prototype', 'dependencySmokeMarker'], true)
  assert.equal(Object.prototype.dependencySmokeMarker, undefined)

  const cloud = apiRequire('wx-server-sdk')
  cloud.init({ env: 'local-dependency-smoke' })
  const db = cloud.database()
  const query = db.collection('dependency_checks').where({ status: db.command.in(['paid']), _id: db.command.gt('cursor') }).orderBy('_id', 'asc').limit(100)
  let captured
  query._query._request.send = async (action, parameters) => {
    captured = { action, parameters }
    return { data: { list: [JSON.stringify({ _id: 'sample', status: 'paid' })] }, requestId: 'local' }
  }
  const rows = await query.get()
  assert.equal(rows.data[0]._id, 'sample')
  assert.equal(captured.action, 'database.getDocument')
  assert.equal(captured.parameters.limit, 100)
  const filters = JSON.parse(captured.parameters.query)
  assert.deepEqual(filters.status.$in, ['paid'])
  assert.equal(filters._id.$gt, 'cursor')

  // Exercise the installed SDK's real transaction serializer. A plain object
  // becomes publicContent.images/text dotted writes, which fail when the stored
  // publicContent is null. Explicit set must replace the entire snapshot.
  const Database = db._db.constructor, Request = Database.reqClass, writes = []
  const snapshot = { text: '这是我们的回忆', images: [{ uploadId: 'image-1', entrance: true }],
    videos: [{ uploadId: 'video-1', entrance: false }], music: null }
  Database.reqClass = class {
    async send(action, parameters) {
      if (action === 'database.startTransaction') return { transactionId: 'local-memory-review' }
      if (action === 'database.commitTransaction' || action === 'database.abortTransaction') return {}
      assert.equal(action, 'database.modifyDocument')
      assert.equal(parameters.transactionId, 'local-memory-review')
      writes.push(JSON.parse(parameters.data))
      return { data: { updated: 1 }, requestId: 'local' }
    }
  }
  try {
    const tx = await db.startTransaction(), doc = tx.collection('dependency_checks').doc('memory')
    await doc.update({ data: { publicContent: snapshot } })
    await doc.update({ data: { status: 'approved', publicContent: db.command.set(snapshot) } })
    await tx.commit()
    assert.ok(Object.hasOwn(writes[0].$set, 'publicContent.images'))
    assert.deepEqual(writes[1].$set, { status: 'approved', publicContent: snapshot })
    assert.ok(Object.keys(writes[1].$set).every(key => !key.startsWith('publicContent.')))
  } finally {
    Database.reqClass = Request
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/echo' })
      return response.end()
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ method: request.method, body: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const axios = apiRequire('axios')
    const client = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false, timeout: 3000 })
    assert.equal((await client.get('/redirect')).data.method, 'GET')
    assert.deepEqual((await client.post('/echo', { scope: 'local-check' })).data.body, { scope: 'local-check' })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  console.log('API dependency compatibility passed: SDK query/transaction snapshot serialization, Lodash function/default exports, Axios JSON and redirects.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
