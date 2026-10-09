const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

for (const role of ['client', 'staff']) test(`${role} message detail deduplicates older pages, drains incremental pages, and preserves state on failure`, async () => {
  let page, next, reads = 0, marks = 0, errors = 0
  const calls = []
  const callFunction = async (module, action, data) => {
    if (action === 'markThreadRead') { marks++; return {} }
    reads++; calls.push(data)
    return next(data)
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../../miniprogram/pages/${role}/messages/thread/index.js`), 'utf8'), {
    Page: definition => { page = definition },
    require: name => name.endsWith('/cloud') ? { callFunction, showError: () => { errors++ } }
      : name.endsWith('/format') ? { formatDateTime: value => value }
        : name.endsWith('/client-nav') ? { refreshUnread: async () => {} } : {}, wx: {}
  })
  page.data.id = 'thread'
  page.setData = changes => Object.assign(page.data, changes)
  const cursor = id => ({ id, time: '2026-10-01T02:00:00Z' })
  const result = (ids, hasMore) => ({ thread: { _id: 'thread' }, messages: ids.map(_id => ({ _id })), before: cursor(ids[0]), after: cursor(ids[ids.length - 1]), hasMore })
  next = async () => result(['m2', 'm3'], true)
  await page.load()
  assert.equal(page.data.hasOlder, true)
  next = async data => { assert.equal(data.before.id, 'm2'); return result(['m1', 'm2'], false) }
  await page.loadOlder()
  assert.equal(page.data.after.id, 'm3')
  assert.equal(page.data.hasOlder, false)
  next = async data => data.after.id === 'm3' ? result(['m3', 'm4'], true) : result(['m5'], false)
  const beforeMarks = marks
  await page.load()
  assert.equal(marks, beforeMarks + 1)
  assert.equal(page.data.messages.map(row => row._id).join(','), 'm1,m2,m3,m4,m5')
  assert.equal(page.data.after.id, 'm5')
  next = async () => { throw new Error('timeout') }
  await page.load()
  assert.equal(errors, 1)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.after.id, 'm5')
  let release
  next = () => new Promise(resolve => { release = resolve })
  const pending = page.load()
  const previousReads = reads
  page.load()
  assert.equal(reads, previousReads)
  release(result([], false))
  await pending
  assert.equal(calls[calls.length - 1].after.id, 'm5')
})
