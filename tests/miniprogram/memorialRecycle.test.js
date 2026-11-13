const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
const deadline = require('../../miniprogram/packageMemorial/scene/recovery-time').deadline
function fixture(wxOverrides = {}) {
  let page, response, listing, confirmed = true
  const calls = [], routes = []
  const row = { id: 'app', locationRevision: 3, petName: '小白', gardenId: 'garden', gardenName: '时光纪念园', plotId: 'plot', recoverUntil: Date.parse('2026-11-20T08:30:00Z') }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/recycle'), 'utf8'), {
    Page: value => { page = value }, require: name => name.endsWith('/cloud') ? { callFunction: async (_, action, data) => { calls.push({ action, data }); if (action === 'listRecycle') return listing ? listing() : { list: [row], hasMore: false }; if (response) return response(); return { id: row.id, gardenId: row.gardenId, plotId: row.plotId } } } : name.endsWith('/recovery-time') ? { deadline } : { plotNumber: () => '01-01' },
    wx: { showModal: o => o.success({ confirm: confirmed }), showToast() {}, navigateTo: o => { routes.push(o.url); if (o.complete) o.complete() }, ...wxOverrides }
  })
  page.setData = data => Object.assign(page.data, data); page.onLoad()
  return { page, calls, routes, row, list: fn => { listing = fn }, respond: fn => { response = fn }, confirm: value => { confirmed = value } }
}
const event = { currentTarget: { dataset: { id: 'app' } } }
test('recycle renders Beijing deadline, restores with current revision, and links to the restored location', async () => {
  const f = fixture(); await f.page.load()
  assert.equal(f.page.data.rows[0].deadline, '2026-11-20 16:30:00')
  f.confirm(false); await f.page.restoreOriginal(event)
  assert.equal(f.calls.some(c => c.action === 'restore'), false)
  f.confirm(true); await f.page.restoreOriginal(event)
  const request = f.calls.find(c => c.action === 'restore').data
  assert.equal(request.locationRevision, 3); assert.equal(request.original, true)
  assert.equal(f.page.data.rows.length, 0)
  f.page.visitRestored(); assert.equal(f.routes[0], '/packageMemorial/pages/garden?gardenId=garden&plotId=plot')
})
test('failed original-location restoration retains contents and supports selecting a new garden', async () => {
  const f = fixture(); await f.page.load()
  f.respond(() => { throw new Error('原位置已被占用') })
  await f.page.restoreOriginal(event)
  assert.equal(f.page.data.rows.length, 1); assert.match(f.page.data.error, /占用/)
  assert.equal(f.page.data.busy, '')
  f.page.chooseLocation(event)
  assert.equal(f.routes[0], '/packageMemorial/pages/entrance?moveId=app&restore=1')
})

test('returning from another page reloads recycle state and ignores a suspended old list', async () => {
  const f = fixture()
  let finishOld
  f.list(() => new Promise(r => { finishOld = r }))
  const old = f.page.load()
  f.page.onHide()
  f.list(() => ({ list: [], hasMore: false }))
  await f.page.load()
  finishOld({ list: [f.row], hasMore: false })
  await old
  assert.equal(f.page.data.rows.length, 0)
  assert.equal(f.page.data.loading, false)
})
test('a refresh cannot reinsert a recycled row while restoration is pending', async () => {
  const f = fixture(); await f.page.load()
  let finish
  f.respond(() => new Promise(r => { finish = r }))
  const restoring = f.page.restoreOriginal(event)
  await new Promise(r => setImmediate(r))
  const before = f.calls.length
  await f.page.load()
  assert.equal(f.calls.length, before)
  finish({ id: 'app', gardenId: 'garden', plotId: 'plot' })
  await restoring
  assert.equal(f.page.data.rows.length, 0)
})

test('recycle hides empty state until first listing finishes', async () => {
  const f = fixture(); assert.equal(f.page.data.loaded, false)
  await f.page.load(); assert.equal(f.page.data.loaded, true)
})
test('hiding recycle during restore confirmation cancels the pending action', async () => {
  let confirm
  const f = fixture({ showModal: options => { confirm = options.success } }); await f.page.load()
  const pending = f.page.restoreOriginal(event)
  f.page.onHide(); confirm({ confirm: true }); await pending
  assert.equal(f.calls.some(c => c.action === 'restore'), false)
  assert.equal(f.page.data.busy, '')
})
test('navigation failure releases the lock and presents retry feedback', async () => {
  let attempts = 0
  const f = fixture({ navigateTo: o => { attempts++; o.fail(); o.complete() } }); await f.page.load()
  f.page.chooseLocation(event); f.page.chooseLocation(event)
  assert.equal(attempts, 2); assert.match(f.page.data.error, /页面未能打开/)
})
