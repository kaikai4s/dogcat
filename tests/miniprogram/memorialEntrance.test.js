const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
function fixture() {
  let page, resolve
  const routes = [], requests = []
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/entrance'), 'utf8'), {
    Page: value => { page = value }, require: () => ({ callFunction: (_, action, data) => { requests.push({ action, data }); return new Promise(r => { resolve = r }) } }),
    wx: { redirectTo: o => { routes.push(o.url); o.complete() }, showToast() {} }
  })
  page.setData = data => Object.assign(page.data, data)
  return { page, routes, requests, resolve: value => resolve(value) }
}
const flush = () => new Promise(r => setImmediate(r))
test('entrance waits for garden choice and carries migration through pagination while paused gardens remain visitable', async () => {
  const f = fixture(); f.page.onLoad({ moveId: 'app' })
  assert.equal(f.routes.length, 0)
  f.resolve({ list: [{ id: 'a', accepting: false }], cursor: 'next', hasMore: true }); await flush()
  f.page.enter({ currentTarget: { dataset: { id: 'a' } } })
  assert.equal(f.routes.length, 0)
  const loading = f.page.load({ currentTarget: { dataset: { more: true } } })
  assert.equal(f.requests[1].data.cursor, 'next')
  f.resolve({ list: [{ id: 'b', accepting: true }], hasMore: false }); await loading
  f.page.enter({ currentTarget: { dataset: { id: 'b' } } })
  assert.equal(f.routes[0], '/packageMemorial/pages/garden?gardenId=b&moveId=app')
  f.page.moveId = ''
  f.page.enter({ currentTarget: { dataset: { id: 'a' } } })
  assert.equal(f.routes[1], '/packageMemorial/pages/garden?gardenId=a')
})
test('a late garden listing cannot update an unloaded entrance', async () => {
  const f = fixture(); f.page.onLoad(); f.page.onUnload()
  f.resolve({ list: [{ id: 'late' }] }); await flush()
  assert.equal(f.page.data.gardens.length, 0)
})
