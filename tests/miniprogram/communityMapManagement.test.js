const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { communityLocationFields } = require('../../miniprogram/pages/admin/community-map/location')

function fixture(kind, options = {}) {
  let page
  const requests = [], errors = []
  let locationWrites = 0
  const cloud = { requirePrivacyAuthorize: async () => {}, showError: error => errors.push(error),
    chooseSelectedLocation: async () => { locationWrites++; throw new Error('must not overwrite the service address') },
    callFunction(module, action, data) { return new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })) } }
  const file = require.resolve(kind === 'admin' ? '../../miniprogram/pages/admin/community-map/index.js' : '../../miniprogram/pages/common/community-map/settings.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page(value) { page = value }, wx: { showToast() {}, ...options.wx },
    require(name) { return name === './location' ? require('../../miniprogram/pages/admin/community-map/location')
      : name.endsWith('utils/offlineQueue') ? require('../../miniprogram/utils/offlineQueue') : cloud } })
  page.data = { ...page.data, ...options.data }
  page.setData = function (patch, callback) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'), field = parts.pop()
      let node = this.data
      for (const part of parts) node = node[part] || (node[part] = {})
      node[field] = value
    }
    callback?.()
  }
  return { page, requests, errors, locationWrites: () => locationWrites }
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }
const tap = (id) => ({ currentTarget: { dataset: { id } } })
const rejectionData = () => ({ adminPermissions: { communityMap_rejectApplication: true }, rows: [
  { _id: 'candidate', name: '花园', applicationIds: ['application-a', 'application-b'], orderCount: 2, staffCount: 1 },
  { _id: 'address-only', name: '地址候选', applicationIds: [], orderCount: 1 }
] })

test('rejection requires separate permission and application IDs, including for direct handlers', () => {
  for (const data of [rejectionData(), { ...rejectionData(), adminPermissions: { communityMap_saveAdmin: true } },
    { ...rejectionData(), adminPermissions: { communityMap_listAdmin: true } }, { ...rejectionData(), adminPermissions: {}, adminSuper: true }]) {
    const { page, requests } = fixture('admin', { data })
    page.rejectCandidate(tap('address-only')); assert.equal(page.data.rejectForm, null)
    page.rejectCandidate(tap('candidate'))
    assert.equal(!!page.data.rejectForm, !!(data.adminSuper || data.adminPermissions.communityMap_rejectApplication))
    assert.equal(requests.length, 0)
  }
  const template = fs.readFileSync(require.resolve('../../miniprogram/pages/admin/community-map/index.wxml'), 'utf8')
  assert.match(template, /item\.applicationIds\.length && \(adminSuper \|\| adminPermissions\.communityMap_rejectApplication\)/)
  assert.match(template, /maxlength="200"/)
  assert.match(template, /永久不可再次申请/)
})

test('community deletion requires its own permission and preserves the old residents in confirmation', async () => {
  let modal
  const row = { _id: 'map_community_' + 'a'.repeat(24), name: '花园', editVersion: 4 }
  const data = { view: 'catalog', rows: [row], adminPermissions: { communityMap_deleteAdmin: true } }
  const blocked = fixture('admin', { data: { ...data, adminPermissions: { communityMap_saveAdmin: true } } })
  await blocked.page.deleteCommunity(tap(row._id))
  assert.equal(blocked.requests.length, 0)
  const { page, requests } = fixture('admin', { data, wx: { showModal(args) { modal = args } } })
  const pending = page.deleteCommunity(tap(row._id))
  assert.match(modal.content, /不会清除已入住用户的庭院/)
  assert.match(modal.content, /不再接受新住户和访客/)
  assert.equal(requests.length, 0)
  modal.success({ confirm: true }); await settle()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].action, 'deleteAdmin')
  assert.equal(requests[0].data.editVersion, 4)
  requests[0].resolve({ id: row._id, retired: true }); await settle()
  assert.equal(requests[1].action, 'listAdmin')
  requests[1].resolve({ list: [], total: 0, hasMore: false }); await pending
  assert.equal(page.data.busy, false)
  const template = fs.readFileSync(require.resolve('../../miniprogram/pages/admin/community-map/index.wxml'), 'utf8')
  assert.match(template, /communityMap_deleteAdmin/)
  assert.match(template, /data-view="retired"/)
})

test('rejection validates reason, confirms permanent effect, prevents reentry and refreshes candidates', async () => {
  let modal
  const { page, requests, errors } = fixture('admin', { data: rejectionData(), wx: { showModal(args) { modal = args } } })
  page.rejectCandidate(tap('candidate'))
  for (const reason of ['', '   ', '长'.repeat(201)]) {
    page.inputRejectReason({ detail: { value: reason } }); await page.submitReject()
  }
  assert.equal(errors.length, 3); assert.equal(requests.length, 0)
  page.inputRejectReason({ detail: { value: '  重复申请  ' } })
  const submit = page.submitReject()
  assert.match(modal.content, /永久不可再次申请/); assert.match(modal.content, /不删除订单或宠托师地址候选/)
  await page.submitReject(); page.closeReject(); page.add()
  page.inputRejectReason({ detail: { value: '不可更改' } })
  assert.equal(page.data.rejectForm.reason, '  重复申请  '); assert.equal(page.data.form, null)
  modal.success({ confirm: true }); await settle()
  assert.equal(requests.length, 1); assert.equal(requests[0].action, 'rejectApplication')
  assert.equal(JSON.stringify(requests[0].data), JSON.stringify({ applicationIds: ['application-a', 'application-b'], reason: '重复申请' }))
  requests[0].resolve({ rejectedCount: 2 }); await settle()
  assert.equal(requests[1].action, 'listAdmin')
  requests[1].resolve({ list: [{ _id: 'candidate', orderCount: 2, staffCount: 1, applicationIds: [] }], total: 1, hasMore: false }); await submit
  assert.equal(page.data.rejectForm, null); assert.equal(page.data.busy, false)
  assert.equal(page.data.rows[0].orderCount, 2); assert.equal(page.data.rows[0].staffCount, 1)
})

test('cancelled confirmation sends nothing; failed rejection retains identical retry payload without requestId', async () => {
  let confirm = false
  const { page, requests } = fixture('admin', { data: rejectionData(), wx: { showModal(args) { args.success({ confirm }) } } })
  page.rejectCandidate(tap('candidate')); page.inputRejectReason({ detail: { value: '资料不实' } })
  await page.submitReject(); assert.equal(requests.length, 0); assert.equal(page.data.busy, false)
  confirm = true
  const first = page.submitReject(); await settle()
  requests[0].reject(new Error('响应丢失')); await first
  assert.ok(page.data.rejectForm)
  const retry = page.submitReject(); await settle()
  assert.equal(JSON.stringify(requests[1].data), JSON.stringify(requests[0].data)); assert.equal(requests[1].data.requestId, undefined)
  requests[1].reject(new Error('网络未恢复')); await retry
  page.closeReject(); assert.equal(page.data.rejectForm, null)
})

test('unloaded rejection confirmations and API responses cannot send requests or write page state', async () => {
  for (const stage of ['confirmation', 'success', 'failure']) {
    let modal
    const { page, requests, errors } = fixture('admin', { data: rejectionData(), wx: { showModal(args) { modal = args } } })
    page.rejectCandidate(tap('candidate')); page.inputRejectReason({ detail: { value: '错误资料' } })
    const pending = page.submitReject()
    if (stage !== 'confirmation') { modal.success({ confirm: true }); await settle() }
    page.onUnload()
    page.setData = () => assert.fail('unloaded page must not be updated')
    if (stage === 'confirmation') modal.success({ confirm: true })
    else if (stage === 'success') requests[0].resolve({ rejectedCount: 2 })
    else requests[0].reject(new Error('late error'))
    await pending
    assert.equal(requests.length, stage === 'confirmation' ? 0 : 1); assert.equal(errors.length, 0)
    await page.submitReject()
  }
})

test('public POI autofill extracts city, district and a community name from the entrance', () => {
  const fields = communityLocationFields({ latitude: 22.5, longitude: 114, name: '阳光花园（南门）', address: '广东省深圳市南山区某路' })
  assert.equal(fields.city, '深圳市'); assert.equal(fields.district, '南山区'); assert.equal(fields.name, '阳光花园')
})

test('admin point selection fills public metadata without writing the personal service location', async () => {
  let finish
  const { page, requests, locationWrites } = fixture('admin', { wx: { chooseLocation(args) { finish = args.success } } })
  page.add()
  const choose = page.choose(); await settle()
  page.onShow()
  assert.equal(requests.length, 0, 'returning from native picker must not start a competing reload')
  finish({ latitude: 22.5, longitude: 114, name: '阳光花园东门', address: '广东省深圳市南山区某路' }); await choose
  assert.equal(page.data.form.name, '阳光花园'); assert.equal(page.data.form.city, '深圳市')
  assert.equal(page.data.form.district, '南山区'); assert.equal(page.data.form.confirmPublic, false)
  assert.equal(locationWrites(), 0)
})

test('admin cancellation retains the form and a picker result cannot modify a replacement form', async () => {
  const cancelled = fixture('admin', { wx: { chooseLocation(args) { args.fail({ errMsg: 'chooseLocation:fail cancel' }) } } })
  cancelled.page.add(); await cancelled.page.choose()
  assert.equal(cancelled.errors.length, 0); assert.equal(cancelled.page.data.form.latitude, 0)
  let complete
  const current = fixture('admin', { wx: { chooseLocation(args) { complete = args.success } } })
  current.page.add()
  const choose = current.page.choose(); await settle()
  current.page.openForm({ name: '另一个表单' })
  complete({ latitude: 22.5, longitude: 114, name: '原表单地点' }); await choose
  assert.equal(current.page.data.form.name, '另一个表单')
  assert.equal(current.page.data.form.latitude, undefined)
})

test('admin list ignores old city results and pagination appends the current list', async () => {
  const { page, requests } = fixture('admin')
  const old = page.load()
  const current = page.changeCity({ detail: { value: ['上海市', '市辖区', '浦东新区'] } })
  assert.equal(requests[1].data.city, '上海市')
  requests[1].resolve({ list: [{ _id: 'new' }], total: 2, hasMore: true }); await current
  requests[0].resolve({ list: [{ _id: 'old' }], total: 1, hasMore: false }); await old
  assert.equal(page.data.rows[0]._id, 'new')
  const more = page.more()
  assert.equal(requests[2].data.offset, 1)
  requests[2].resolve({ list: [{ _id: 'next' }], total: 2, hasMore: false }); await more
  assert.equal(page.data.rows.map(row => row._id).join(','), 'new,next')
})

test('admin edits require renewed confirmation and preserve edit versions in save requests', async () => {
  const row = { _id: 'c', revision: 1, editVersion: 3, name: '花园', city: '上海市', district: '', aliases: [], latitude: 31.2, longitude: 121.5 }
  const { page, requests } = fixture('admin', { data: { rows: [row] } })
  page.edit(tap('c')); page.confirm()
  page.input({ currentTarget: { dataset: { field: 'aliasesText' } }, detail: { value: '旧名' } })
  assert.equal(page.data.form.confirmPublic, false)
  page.confirm()
  const save = page.save()
  assert.equal(requests[0].data.editVersion, 3); assert.equal(requests[0].data.aliases[0], '旧名')
  requests[0].resolve({ id: 'c' }); await settle()
  requests[1].resolve({ list: [], total: 0, hasMore: false }); await save
  assert.equal(page.data.form, null); assert.equal(page.data.busy, false)
})

test('staff recommendations paginate beyond 30 points and reset a previous choice when searching', async () => {
  const { page, requests } = fixture('settings', { data: { profile: { serviceCity: '上海市' } } })
  const first = page.search()
  assert.equal(requests[0].data.recommended, true)
  requests[0].resolve({ list: Array.from({ length: 30 }, (_, i) => ({ _id: 'c' + i })), hasMore: true }); await first
  page.select(tap('c0')); page.confirm()
  const more = page.more()
  assert.equal(requests[1].data.offset, 30)
  requests[1].resolve({ list: [{ _id: 'c30' }], hasMore: false }); await more
  assert.equal(page.data.communities.length, 31); assert.equal(page.data.selected._id, 'c0')
  const search = page.search()
  assert.equal(page.data.selected, null); assert.equal(page.data.confirmed, false)
  requests[2].resolve({ list: [], hasMore: false }); await search
})

test('staff profile reloads fence stale searches and disable saving against the old profile', async () => {
  const { page, requests } = fixture('settings', { data: { profile: { serviceRadiusKm: 5 }, selected: { _id: 'old', revision: 1 }, confirmed: true } })
  const old = page.search()
  const load = page.load()
  assert.equal(page.data.selected, null); assert.equal(page.data.loadingProfile, true)
  await page.save()
  requests[0].resolve({ list: [{ _id: 'old' }], hasMore: false }); await old
  requests[1].resolve({ serviceCity: '上海市', serviceRadiusKm: 8 }); await settle()
  requests[2].resolve({ list: [{ _id: 'current' }], hasMore: false }); await load
  assert.equal(page.data.communities[0]._id, 'current'); assert.equal(page.data.profile.serviceRadiusKm, 8)
})

test('staff confirmation cannot switch communities while publication is pending', async () => {
  const { page, requests, errors } = fixture('settings', { data: { profile: { serviceRadiusKm: 5 },
    communities: [{ _id: 'a', revision: 1 }, { _id: 'b', revision: 1 }], selected: { _id: 'a', revision: 1 }, confirmed: true } })
  const save = page.save()
  page.select(tap('b')); page.confirm()
  assert.equal(page.data.selected._id, 'a'); assert.equal(requests[0].data.communityId, 'a')
  page.onUnload(); requests[0].reject(new Error('transport closed')); await save
  assert.equal(errors.length, 0)
})

test('admin save retries retain a request ID until the content or form changes', async () => {
  const { page, requests } = fixture('admin')
  page.openForm({ name: '阳光花园', city: '上海市', district: '', latitude: 31.2, longitude: 121.5, aliasesText: '', confirmPublic: true })
  const first = page.save(), requestId = requests[0].data.requestId
  assert.ok(requestId)
  requests[0].reject(new Error('响应丢失')); await first
  const retry = page.save()
  assert.equal(requests[1].data.requestId, requestId)
  requests[1].reject(new Error('网络尚未恢复')); await retry
  page.input({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '另一个花园' } }); page.confirm()
  const changed = page.save()
  assert.notEqual(requests[2].data.requestId, requestId)
  requests[2].reject(new Error('稍后重试')); await changed
  const changedId = requests[2].data.requestId
  page.close(); page.openForm({ name: '另一个花园', city: '上海市', latitude: 31.2, longitude: 121.5, aliasesText: '', confirmPublic: true })
  const reopened = page.save()
  assert.notEqual(requests[3].data.requestId, changedId)
  requests[3].reject(new Error('响应丢失')); await reopened
})

test('recommendation pagination uses the submitted search and retries a failed page without clearing selection', async () => {
  const { page, requests } = fixture('settings', { data: { profile: { serviceCity: '上海市' }, keyword: '花园' } })
  const first = page.search()
  requests[0].resolve({ list: [{ _id: 'a' }], hasMore: true }); await first
  page.select(tap('a')); page.confirm()
  page.input({ detail: { value: '还没有搜索的新词' } })
  const more = page.more()
  assert.equal(requests[1].data.keyword, '花园'); assert.equal(requests[1].data.offset, 1)
  requests[1].reject(new Error('网络中断')); await more
  const retry = page.retry()
  assert.equal(requests[2].data.keyword, '花园'); assert.equal(requests[2].data.offset, 1)
  assert.equal(page.data.selected._id, 'a'); assert.equal(page.data.confirmed, true)
  requests[2].resolve({ list: [{ _id: 'b' }], hasMore: false }); await retry
  assert.equal(page.data.communities.map(row => row._id).join(','), 'a,b')
  const search = page.search()
  assert.equal(requests[3].data.keyword, '还没有搜索的新词'); assert.equal(requests[3].data.offset, 0)
  assert.equal(page.data.selected, null)
  requests[3].resolve({ list: [], hasMore: false }); await search
})

test('first-page retries retain the failed query while draft text changes', async () => {
  const { page, requests } = fixture('settings', { data: { profile: {}, keyword: '旧词' } })
  const first = page.search()
  requests[0].reject(new Error('网络中断')); await first
  page.input({ detail: { value: '新词' } })
  const retry = page.retry()
  assert.equal(requests[1].data.keyword, '旧词'); assert.equal(requests[1].data.offset, 0)
  requests[1].resolve({ list: [], hasMore: false }); await retry
})

test('publication fences searches and reloads until the confirmed save finishes', async () => {
  const { page, requests } = fixture('settings', { data: { profile: { serviceRadiusKm: 5 }, selected: { _id: 'a', revision: 1 }, confirmed: true } })
  const save = page.save()
  await page.search(); await page.load(); await page.retry()
  assert.equal(requests.length, 1); assert.equal(page.data.selected._id, 'a')
  requests[0].resolve({ enabled: true }); await settle()
  assert.equal(requests[1].action, 'getStaffProfile')
  requests[1].resolve({ publicMapEnabled: true, serviceRadiusKm: 5, serviceCity: '上海市' }); await settle()
  assert.equal(requests[2].action, 'catalog')
  requests[2].resolve({ list: [], hasMore: false }); await save
  assert.equal(page.data.busy, false); assert.equal(page.data.profile.publicMapEnabled, true)
})

test('late existing-community lookups cannot replace a newer form or a changed list', async () => {
  const first = fixture('admin', { data: { rows: [{ _id: 'candidate', existingId: 'old' }] } })
  const pending = first.page.editExisting(tap('candidate'))
  first.page.add()
  first.requests[0].resolve({ list: [{ _id: 'old', name: '旧小区' }] }); await pending
  assert.equal(first.page.data.form.id, undefined); assert.equal(first.page.data.form.name, '')
  assert.equal(first.page.data.busy, false)
  const second = fixture('admin', { data: { rows: [{ _id: 'candidate', existingId: 'old' }] } })
  const lookup = second.page.editExisting(tap('candidate'))
  const list = second.page.changeView({ currentTarget: { dataset: { view: 'catalog' } } })
  second.requests[0].reject(new Error('已过期的查询失败')); await lookup
  assert.equal(second.errors.length, 0); assert.equal(second.page.data.form, null)
  second.requests[1].resolve({ list: [], total: 0, hasMore: false }); await list
  assert.equal(second.page.data.busy, false)
})

test('existing-community lookup succeeds and a pending save cannot be replaced by another form', async () => {
  const applicationIds = ['map_application_' + 'a'.repeat(32)]
  const { page, requests } = fixture('admin', { data: { rows: [{ _id: 'candidate', existingId: 'old', applicationIds }] } })
  const edit = page.editExisting(tap('candidate'))
  requests[0].resolve({ list: [{ _id: 'old', name: '已维护花园', city: '上海市', latitude: 31.2, longitude: 121.5, aliases: [] }] }); await edit
  assert.equal(page.data.form.id, 'old'); assert.equal(page.data.busy, false)
  page.confirm()
  const save = page.save()
  assert.equal(requests[1].data.applicationIds.join(','), applicationIds.join(','))
  page.add()
  assert.equal(page.data.form.id, 'old')
  requests[1].reject(new Error('网络中断')); await save
  assert.equal(page.data.busy, false)
})
