const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))
function setup(respond) {
  let definition
  const calls = [], errors = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/components/community-chooser/index.js'), 'utf8'), {
    Component(value) { definition = value }, require() { return {
      callFunction(module, action, data) { calls.push({ module, action, data }); return Promise.resolve().then(() => respond(action, data)) },
      chooseSelectedLocation: async () => ({ name: '地图小区', address: '公园路', city: '上海', district: '浦东' }),
      showError(error) { errors.push(error.message) }
    } }
  })
  const component = { ...definition.methods, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch) } }
  return { component, calls, errors }
}
test('community selection displays real counts and returns public community identity only after tapping a row', async () => {
  const item = { id: 'c', community: { name: '阳光小区', city: '上海', district: '浦东' }, residentCount: 132 }
  const { component } = setup(() => ({ list: [item], hasMore: false }))
  let selected = false
  const selection = component.open().then(value => { selected = true; return value })
  await flush()
  assert.equal(component.data.list[0].residentCount, 132)
  assert.equal(selected, false)
  component.select({ currentTarget: { dataset: { id: 'c' } } })
  const result = await selection
  assert.equal(result.district, '浦东')
  assert.equal(component.data.visible, false)
})
test('map selection creates only a public-name application and cannot select an unreviewed community', async () => {
  let fail = true
  const { component, errors, calls } = setup((action) => {
    if (action === 'listCommunities') return { list: [], hasMore: false }
    if (fail) throw new Error('申请暂时无法提交')
    return { applicationId: 'application', status: 'pending' }
  })
  const selection = component.open()
  let selected = false
  selection.then(() => { selected = true }, () => {})
  await flush()
  await component.map()
  assert.equal(component.data.applyForm.name, '地图小区')
  assert.equal(calls.some(call => call.action === 'getCommunityInfo'), false)
  await component.submitApplication()
  assert.deepEqual(errors, ['申请暂时无法提交'])
  assert.equal(component.data.applyForm.name, '地图小区')
  assert.equal(component.data.visible, true)
  fail = false
  await component.submitApplication()
  const application = calls.find(call => call.action === 'applyCommunity')
  assert.equal(application.module, 'communityMap')
  assert.equal(Object.keys(application.data).sort().join(','), 'city,district,name')
  assert.match(component.data.applicationNotice, /后台核验/)
  assert.equal(selected, false)
  assert.equal(component.data.visible, true)
  const cancelled = assert.rejects(selection, error => String(error.errMsg).includes('cancel'))
  component.close()
  await cancelled
})
test('closing the community selector cancels without changing the selected community', async () => {
  const { component } = setup(() => ({ list: [], hasMore: false }))
  const selection = component.open()
  const result = assert.rejects(selection, error => String(error.errMsg).includes('cancel'))
  component.close()
  await result
  await flush()
  assert.equal(component.data.visible, false)
})

test('pagination keeps the submitted filters when input drafts change and deduplicates overlapping rows', async () => {
  const row = { id: 'a', community: { name: '阳光小区' } }
  const f = setup((action, data) => ({ list: data.page === 1 ? [row] : [row, { id: 'b', community: { name: '另一小区' } }], hasMore: true }))
  const selection = f.component.open().catch(() => {})
  await flush()
  f.component.city({ detail: { value: '上海' } })
  f.component.keyword({ detail: { value: '阳光' } })
  f.component.search()
  await flush()
  f.component.city({ detail: { value: '北京' } })
  f.component.keyword({ detail: { value: '尚未搜索' } })
  f.component.more()
  await flush()
  assert.deepEqual({ ...f.calls.at(-1).data }, { keyword: '阳光', city: '上海', page: 2 })
  assert.equal(f.component.data.list.length, 2)
  f.component.close()
  await selection
})

test('submission cannot be interrupted by searching and remains visible until its result is confirmed', async () => {
  let complete
  const f = setup(action => action === 'applyCommunity' ? new Promise(resolve => { complete = resolve }) : { list: [], hasMore: false })
  const selection = f.component.open().catch(() => {})
  await flush()
  f.component.newApplication()
  f.component.inputApplication({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '阳光小区' } })
  f.component.inputApplication({ currentTarget: { dataset: { field: 'city' } }, detail: { value: '上海' } })
  const pending = f.component.submitApplication()
  await flush()
  const before = f.calls.length
  f.component.search()
  f.component.close()
  assert.equal(f.component.data.visible, true)
  assert.equal(f.calls.length, before)
  complete({ status: 'pending' })
  await pending
  assert.match(f.component.data.applicationNotice, /申请已提交/)
  assert.equal(f.component.data.applyForm, null)
  assert.equal(f.component.data.applying, false)
  f.component.close()
  await selection
})

test('failed replacement search clears stale rows so they cannot select a community under the wrong filter', async () => {
  const f = setup((action, data) => { if (data.keyword) throw new Error('搜索失败'); return { list: [{ id: 'a', community: { name: '旧结果' } }], hasMore: false } })
  const selection = f.component.open().catch(() => {})
  await flush()
  assert.equal(f.component.data.list.length, 1)
  f.component.keyword({ detail: { value: '新条件' } })
  f.component.search()
  await flush()
  assert.equal(f.component.data.list.length, 0)
  assert.equal(f.component.data.error, '搜索失败')
  f.component.close()
  await selection
})

test('a successful application releases controls while its directory refresh is still pending', async () => {
  let count = 0, finishRefresh
  const f = setup(action => {
    if (action === 'applyCommunity') return { status: 'pending' }
    if (++count === 1) return { list: [], hasMore: false }
    return new Promise(resolve => { finishRefresh = resolve })
  })
  const selection = f.component.open().catch(() => {})
  await flush()
  f.component.keyword({ detail: { value: '阳光小区' } })
  f.component.city({ detail: { value: '上海' } })
  f.component.newApplication()
  // Do not await submission here: the test can detect locking without hanging.
  const submission = f.component.submitApplication()
  await flush()
  assert.match(f.component.data.applicationNotice, /申请已提交/)
  assert.equal(f.component.data.loading, true)
  assert.equal(f.component.data.applying, false)
  f.component.close()
  await selection
  finishRefresh({ list: [], hasMore: false })
  await submission
  await flush()
  assert.equal(f.component.data.visible, false)
})

test('reapplying after a community was renamed searches its current public name and city', async () => {
  const f = setup(action => action === 'applyCommunity'
    ? { status: 'resolved', community: { name: '阳光花园新名称', city: '上海市' } }
    : { list: [], hasMore: false })
  const selection = f.component.open().catch(() => {})
  await flush()
  f.component.keyword({ detail: { value: '阳光小区旧名称' } })
  f.component.city({ detail: { value: '上海' } })
  f.component.newApplication()
  await f.component.submitApplication()
  await flush()
  assert.equal(f.calls.at(-1).data.keyword, '阳光花园新名称')
  assert.equal(f.calls.at(-1).data.city, '上海市')
  assert.match(f.component.data.applicationNotice, /可在下方选择/)
  f.component.close()
  await selection
})
