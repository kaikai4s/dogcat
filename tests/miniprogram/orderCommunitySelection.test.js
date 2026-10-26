const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const format = require('../../miniprogram/utils/format')
const source = fs.readFileSync(require.resolve('../../miniprogram/pages/client/orders/create/index.js'), 'utf8')
function fixture(options = {}) {
  let page
  const requests = [], errors = []
  const cloud = { ...format, navMethods: () => ({}), createPageNav: () => ({}),
    getSelectedLocation: () => options.selectedLocation || null,
    chooseSelectedLocation: options.chooseSelectedLocation,
    showError: error => errors.push(error),
    callFunction(module, action, data) { return new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })) } }
  vm.runInNewContext(source, { Page(value) { page = value }, require: () => cloud,
    wx: {}, module: { exports: {} }, setTimeout, clearTimeout })
  page.data = JSON.parse(JSON.stringify(page.data))
  Object.assign(page.data.form, { city: '成都市', serviceAddress: '红瓦小区（华府大道二段）', addressLatitude: 30.5, addressLongitude: 104 })
  page.setData = function (patch, callback) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'), field = parts.pop()
      let target = this.data
      for (const part of parts) target = target[part]
      target[field] = value
    }
    callback?.call(this)
  }
  page.showBookingNotice = value => errors.push(value)
  page.checkSitterRange = () => ({ ok: true })
  page.triggerAutoQuote = () => {}
  return { page, requests, errors }
}
const tap = id => ({ currentTarget: { dataset: { id } } })
const row = (id = 'estate') => ({ _id: id, name: '双流区红瓦小区（华府大道二段）', city: '成都市', district: '双流区', latitude: 30.501, longitude: 104 })
test('selecting a public map estate adds an ID to the payload without replacing the service address or point', async () => {
  const { page, requests } = fixture()
  const pending = page.resetOrderCommunity()
  assert.equal(requests[0].action, 'nearbyForOrder')
  requests[0].resolve({ list: [row()], hasMore: false }); await pending
  page.chooseOrderCommunity(tap('estate'))
  assert.equal(page.data.form.serviceCommunityId, 'estate')
  assert.equal(page.data.form.serviceAddress, '红瓦小区（华府大道二段）')
  assert.equal(page.data.form.addressLatitude, 30.5)
  assert.equal(page.buildOrderPayload().serviceCommunityId, 'estate')
  page.clearOrderCommunity(); assert.equal(page.buildOrderPayload().serviceCommunityId, '')
})
test('changing the service address clears estate IDs and ignores older nearby responses', async () => {
  const { page, requests } = fixture()
  const old = page.resetOrderCommunity()
  page.data.form.serviceCommunityId = 'old'; page.data.form.serviceCommunityApplicationId = 'old-application'
  page.data.form.addressLatitude = 30.51
  const current = page.resetOrderCommunity()
  requests[1].resolve({ list: [row('new')], hasMore: false }); await current
  requests[0].resolve({ list: [row('old')], hasMore: false }); await old
  assert.equal(page.data.form.serviceCommunityId, ''); assert.equal(page.data.form.serviceCommunityApplicationId, '')
  assert.equal(page.data.orderCommunities[0]._id, 'new')
})
test('community pagination retains the submitted search and retries the failed page', async () => {
  const { page, requests } = fixture()
  page.data.communityKeyword = '红瓦'
  const first = page.searchOrderCommunities()
  requests[0].resolve({ list: [row('a')], hasMore: true }); await first
  page.data.communityKeyword = '未提交'
  const more = page.moreOrderCommunities()
  assert.equal(requests[1].data.keyword, '红瓦'); assert.equal(requests[1].data.offset, 1)
  requests[1].reject(new Error('network')); await more
  const retry = page.retryOrderCommunities()
  assert.equal(requests[2].data.keyword, '红瓦'); assert.equal(requests[2].data.offset, 1)
  requests[2].resolve({ list: [row('b')], hasMore: false }); await retry
  assert.deepEqual(Array.from(page.data.orderCommunities, row => row._id), ['a', 'b'])
})
test('an application sends only the public name and city and associates the order after success', async () => {
  const { page, requests } = fixture()
  page.data.communityApplicationName = '红瓦小区'; page.data.communityApplicationDistrict = '双流区'
  const pending = page.applyOrderCommunity()
  const payload = requests[0].data
  assert.equal(requests[0].action, 'applyCommunity')
  assert.deepEqual(Object.keys(payload).sort(), ['city', 'district', 'name'])
  page.chooseOrderCommunity(tap('estate'))
  assert.equal(page.data.form.serviceCommunityId, '')
  requests[0].resolve({ applicationId: 'pending-application', status: 'pending' }); await pending
  assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, 'pending-application')
  assert.match(page.data.communityApplicationStatus, /可继续下单/)
  assert.equal(page.data.communityApplicationBusy, false)
})
test('late application replies cannot attach the previous address to a newer address or an unloaded page', async () => {
  for (const close of [false, true]) {
    const { page, requests } = fixture()
    page.data.communityApplicationName = '红瓦小区'
    const old = page.applyOrderCommunity()
    if (close) page.onUnload()
    else { const next = page.resetOrderCommunity(); requests[1].resolve({ list: [], hasMore: false }); await next }
    requests[0].resolve({ applicationId: 'old', status: 'pending' }); await old
    assert.equal(page.data.form.serviceCommunityApplicationId, '')
  }
})
test('legacy saved addresses can choose a city without blocking ordinary order submission', async () => {
  const { page, requests } = fixture()
  page.data.form.city = ''
  await page.resetOrderCommunity()
  assert.equal(requests.length, 0); assert.match(page.data.communityError, /所在城市/)
  const current = page.changeCommunityCity({ detail: { value: ['四川省', '成都市', '双流区'] } })
  requests[0].resolve({ list: [row()], hasMore: false }); await current
  assert.equal(page.data.form.city, '成都市')
  assert.equal(page.data.orderCommunities.length, 1)
})
test('a new application does not change the fixed playground group-buy location', async () => {
  const { page, requests } = fixture()
  page.data.groupBuyMode = true
  await page.resetOrderCommunity()
  assert.equal(requests.length, 0)
  assert.equal(page.data.form.addressLatitude, 30.5)
})

test('choosing a saved address refreshes nearby communities for that address and keeps its stored city', async () => {
  const { page, requests } = fixture()
  let loading
  const load = page.loadOrderCommunities
  page.loadOrderCommunities = function (...args) { loading = load.apply(this, args); return loading }
  page.checkSitterRange = () => ({ ok: true }); page.triggerAutoQuote = () => {}
  page.data.form.serviceCommunityId = 'previous-estate'
  page.applyAddress({ city: '成都市', serviceAddress: '红瓦小区', latitude: 30.51, longitude: 104.01 })
  assert.equal(requests[0].data.city, '成都市')
  assert.equal(requests[0].data.latitude, 30.51)
  assert.equal(page.data.form.serviceCommunityId, '')
  requests[0].resolve({ list: [row()], hasMore: false })
  await loading
  assert.equal(page.data.orderCommunities.length, 1)
})

test('late default and rebooking addresses cannot replace a later saved-address selection or its selected estate', async () => {
  for (const fromHistory of [false, true]) {
    const { page, requests, errors } = fixture()
    const old = fromHistory ? page.loadRebook('history') : page.loadDefaultAddress()
    page.applyAddress({ city: '成都市', serviceAddress: '新服务地点', latitude: 30.51, longitude: 104.01 })
    requests[1].resolve({ list: [row('new-estate')], hasMore: false })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    page.chooseOrderCommunity(tap('new-estate'))
    requests[0].resolve(fromHistory ? { serviceAddress: '旧历史地点', city: '上海市' }
      : [{ isDefault: true, serviceAddress: '旧默认地点', city: '上海市', latitude: 31.2, longitude: 121.5 }])
    await old
    assert.equal(page.data.form.serviceAddress, '新服务地点')
    assert.equal(page.data.form.city, '成都市'); assert.equal(page.data.form.serviceCommunityId, 'new-estate')
    assert.equal(requests.length, 2); assert.equal(errors.length, 0)
  }
})

test('an older default-address failure cannot fall back to the home-page location over a newer address', async () => {
  const { page, requests } = fixture({ selectedLocation: { name: '旧首页位置', city: '上海市', latitude: 31.2, longitude: 121.5 } })
  const old = page.loadDefaultAddress()
  page.applyAddress({ city: '成都市', serviceAddress: '新服务地点', latitude: 30.51, longitude: 104.01 })
  requests[1].resolve({ list: [], hasMore: false })
  requests[0].reject(new Error('network')); await old
  assert.equal(page.data.form.serviceAddress, '新服务地点'); assert.equal(page.data.form.city, '成都市')
  assert.equal(requests.length, 2)
})

test('an old native picker reply cannot clear the estate of a newer address, and unloading prevents late writes', async () => {
  for (const close of [false, true]) {
    let complete
    const { page, requests, errors } = fixture({ chooseSelectedLocation: () => new Promise(resolve => { complete = resolve }) })
    const picker = page.useCurrentLocation()
    if (close) page.onUnload()
    else {
      page.applyAddress({ city: '成都市', serviceAddress: '新服务地点', latitude: 30.51, longitude: 104.01 })
      requests[0].resolve({ list: [], hasMore: false })
    }
    complete({ name: '旧选点', city: '上海市', latitude: 31.2, longitude: 121.5 }); await picker
    assert.equal(page.data.form.city, '成都市')
    assert.notEqual(page.data.form.serviceAddress, '旧选点'); assert.equal(errors.length, 0)
  }
})

test('direct booking and playground group buys omit the hidden map choice from their payload', () => {
  const { page } = fixture()
  page.data.form.serviceCommunityId = 'draft-estate'; page.data.form.serviceCommunityApplicationId = 'draft-application'
  page.data.form.publishMode = 'direct'
  assert.equal(page.buildOrderPayload().serviceCommunityId, '')
  assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, '')
  page.data.form.publishMode = 'open'; page.data.groupBuyMode = true
  assert.equal(page.buildOrderPayload().serviceCommunityId, '')
  page.data.groupBuyMode = false
  assert.equal(page.buildOrderPayload().serviceCommunityId, 'draft-estate')
})

test('address and publish-mode controls do not change the order while submission or an application is pending', async () => {
  const { page, requests } = fixture()
  page.data.creating = true
  page.applyAddress({ city: '上海市', serviceAddress: '其他地址', latitude: 31.2, longitude: 121.5 })
  page.choosePublishMode({ currentTarget: { dataset: { mode: 'direct' } } })
  await page.useCurrentLocation()
  assert.equal(page.data.form.city, '成都市'); assert.equal(page.data.form.publishMode, 'open')
  assert.equal(requests.length, 0)
  page.data.creating = false; page.data.communityApplicationBusy = true
  page.choosePublishMode({ currentTarget: { dataset: { mode: 'direct' } } })
  assert.equal(page.data.form.publishMode, 'open')
})

test('the address editor saves the newly chosen city and clears the old city if the new point cannot be resolved', async () => {
  let page, location
  const deps = { navMethods: () => ({}), chooseSelectedLocation: async () => location, showError: error => { throw error } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/client/addresses/edit/index.js'), 'utf8'), {
    Page(value) { page = value }, require: () => deps
  })
  const helper = fixture()
  page.setData = helper.page.setData
  page.data.form.city = '上海市'
  location = { name: '红瓦小区', address: '四川省成都市双流区华府大道二段', latitude: 30.5, longitude: 104 }
  await page.chooseLocation()
  assert.equal(page.data.form.city, '成都市')
  location = { name: '临街商铺', latitude: 30.51, longitude: 104.01 }
  await page.chooseLocation()
  assert.equal(page.data.form.city, '')
})

test('the address editor ignores a saved-address load after a new pick and a picker reply after unloading', async () => {
  let page, resolveList, resolvePick
  const deps = { navMethods: () => ({}),
    callFunction: () => new Promise(resolve => { resolveList = resolve }),
    chooseSelectedLocation: () => new Promise(resolve => { resolvePick = resolve }), showError: error => { throw error } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/client/addresses/edit/index.js'), 'utf8'), {
    Page(value) { page = value }, require: () => deps
  })
  page.setData = fixture().page.setData
  const old = page.load('address')
  const picked = page.chooseLocation()
  resolvePick({ name: '红瓦小区', city: '成都市', latitude: 30.5, longitude: 104 }); await picked
  resolveList([{ _id: 'address', serviceAddress: '旧地址', city: '上海市' }]); await old
  assert.equal(page.data.form.serviceAddress, '红瓦小区'); assert.equal(page.data.form.city, '成都市')
  const afterClose = page.chooseLocation()
  page.onUnload()
  resolvePick({ name: '迟到选址', city: '上海市', latitude: 31.2, longitude: 121.5 }); await afterClose
  assert.equal(page.data.form.city, '成都市')
})

function rebookTemplate(extra = {}) {
  return { sourceOrderId: 'history', petIds: ['pet'], serviceTypes: ['visit_fee', 'walk'],
    city: '成都市', serviceAddress: '附近临街商铺', addressLatitude: 30.519, addressLongitude: 104,
    addressDetail: '1栋', doorplate: '102', publishMode: 'open', durationMinutes: 60, ...extra }
}

test('rebooking restores the selected estate and keeps it when the nearby list fails or omits it', async () => {
  const { page, requests, errors } = fixture()
  page.prepareTime = () => {}; page.syncSelectedPetUI = () => {}
  const loading = page.loadRebook('history')
  requests[0].resolve(rebookTemplate({ serviceCommunityId: 'estate', orderCommunity: row() }))
  await loading
  assert.equal(page.data.form.serviceCommunityId, 'estate')
  assert.equal(page.data.orderCommunity.name, row().name)
  requests[1].reject(new Error('network'))
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(page.buildOrderPayload().serviceCommunityId, 'estate')
  const retry = page.retryOrderCommunities()
  requests[2].resolve({ list: [row('other-estate')], hasMore: false }); await retry
  assert.equal(page.data.form.serviceCommunityId, 'estate')
  assert.equal(page.data.form.serviceAddress, '附近临街商铺')
  assert.equal(page.data.form.addressLatitude, 30.519)
  assert.equal(errors.length, 0)
  page.applyAddress({ serviceAddress: '新地址', city: '成都市', latitude: 30.51, longitude: 104 })
  assert.equal(page.data.form.serviceCommunityId, '')
  assert.equal(page.data.orderCommunity, null)
  requests[3].resolve({ list: [], hasMore: false })
})

test('rebooking restores a pending application with its public name and clears it when the city changes', async () => {
  const { page, requests } = fixture()
  page.prepareTime = () => {}; page.syncSelectedPetUI = () => {}
  const loading = page.loadRebook('history')
  requests[0].resolve(rebookTemplate({ serviceCommunityApplicationId: 'pending-application',
    orderCommunityApplication: { name: '红瓦小区', status: 'pending' } }))
  await loading
  requests[1].resolve({ list: [], hasMore: false })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, 'pending-application')
  assert.match(page.data.communityApplicationStatus, /红瓦小区.*可继续下单/)
  assert.equal(page.data.orderCommunity, null)
  const changed = page.changeCommunityCity({ detail: { value: ['上海市', '市辖区', '浦东新区'] } })
  requests[2].resolve({ list: [], hasMore: false }); await changed
  assert.equal(page.data.form.serviceCommunityApplicationId, '')
  assert.equal(page.data.communityApplicationStatus, '')
})

test('an invalid history choice shows a durable notice until the user chooses a new estate', async () => {
  const { page, requests } = fixture()
  page.prepareTime = () => {}; page.syncSelectedPetUI = () => {}
  const loading = page.loadRebook('history')
  requests[0].resolve(rebookTemplate({ communitySelectionNotice: '原地图小区或申请已失效，请重新选择附近小区或申请新增。' }))
  await loading
  requests[1].resolve({ list: [row()], hasMore: false })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.match(page.data.communitySelectionNotice, /已失效/)
  assert.equal(page.buildOrderPayload().serviceCommunityId, '')
  page.chooseOrderCommunity(tap('estate'))
  assert.equal(page.data.communitySelectionNotice, '')
  assert.equal(page.buildOrderPayload().serviceCommunityId, 'estate')
})

test('a delayed rebooking render callback cannot restore an old estate after the user changes address', async () => {
  const { page, requests } = fixture()
  page.prepareTime = () => {}; page.syncSelectedPetUI = () => {}
  const setData = page.setData
  let oldCallback
  page.setData = function (patch, callback) {
    if (patch['form.sourceOrderId']) { oldCallback = callback; return setData.call(this, patch) }
    return setData.call(this, patch, callback)
  }
  const loading = page.loadRebook('history')
  requests[0].resolve(rebookTemplate({ serviceCommunityId: 'old-estate', orderCommunity: row('old-estate') }))
  await loading
  page.applyAddress({ serviceAddress: '新地址', city: '成都市', latitude: 30.51, longitude: 104 })
  requests[1].resolve({ list: [row('new-estate')], hasMore: false })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  page.chooseOrderCommunity(tap('new-estate'))
  oldCallback.call(page)
  assert.equal(page.data.form.serviceCommunityId, 'new-estate')
  assert.equal(page.data.form.serviceAddress, '新地址')
  assert.equal(requests.length, 2)
})

for (const outcome of ['created', 'self_duplicate', 'other_duplicate']) {
  test(`pending ${outcome} uses the exact server message and is the only linked application`, async () => {
    const { page, requests } = fixture()
    page.data.communityApplicationName = '红瓦小区'
    page.data.form.serviceCommunityApplicationId = 'stale'
    const message = outcome === 'other_duplicate' ? '其他用户已申请，结果仅通知原申请人' : '申请成功，请等待管理员处理'
    const application = page.applyOrderCommunity()
    await page.applyOrderCommunity()
    assert.equal(requests.length, 1)
    requests[0].resolve({ status: 'pending', outcome, message, applicationId: outcome })
    await application
    assert.equal(page.data.communityApplicationStatus, message)
    assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, outcome)
    assert.equal(page.data.form.serviceCommunityId, '')
    assert.equal(page.data.communityApplicationBusy, false)
  })
}

for (const status of ['existing', 'resolved']) {
  for (const withCommunity of [false, true]) {
    test(`${status} (${withCommunity}) clears stale links and refreshes the original nearby query without selecting the response`, async () => {
      const { page, requests } = fixture()
      page.data.communityKeyword = '原搜索'
      const nearby = page.searchOrderCommunities()
      requests[0].resolve({ list: [row('old')], hasMore: true })
      await nearby
      page.data.communityKeyword = '未提交搜索'
      page.data.communityApplicationName = '申请名称'
      page.data.form.serviceCommunityApplicationId = 'stale-application'
      page.data.form.serviceCommunityId = 'old'
      page.data.orderCommunity = row('old')
      const application = page.applyOrderCommunity()
      const message = withCommunity ? '小区已维护，请重新选择' : '该小区已维护，暂未启用'
      requests[1].resolve({ status, outcome: 'existing', message, applicationId: 'must-not-link',
        ...(withCommunity ? { community: { ...row('far-away'), city: '上海市', name: '异地规范名称', latitude: 31.2 } } : {}) })
      await application
      assert.equal(page.data.communityApplicationStatus, message)
      assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, '')
      assert.equal(page.buildOrderPayload().serviceCommunityId, '')
      assert.equal(page.data.orderCommunity, null)
      assert.equal(page.data.communityApplicationBusy, false)
      assert.equal(requests[2].action, 'nearbyForOrder')
      assert.deepEqual({ ...requests[2].data }, { city: '成都市', latitude: 30.5, longitude: 104, keyword: '原搜索', offset: 0 })
      assert.equal(page.data.form.serviceAddress, '红瓦小区（华府大道二段）')
      requests[2].resolve({ list: [row('eligible')], hasMore: false })
      for (let i = 0; i < 8; i++) await Promise.resolve()
      assert.equal(page.buildOrderPayload().serviceCommunityId, '')
      page.chooseOrderCommunity(tap('far-away'))
      assert.equal(page.buildOrderPayload().serviceCommunityId, '')
      page.chooseOrderCommunity(tap('eligible'))
      assert.equal(page.buildOrderPayload().serviceCommunityId, 'eligible')
    })
  }
}

for (const message of ['申请被驳回且永久禁止重申', '']) {
  test(`rejected orders clear old links and display rejection instead of success (${!!message})`, async () => {
    const { page, requests } = fixture()
    page.data.communityApplicationName = '红瓦小区'
    page.data.form.serviceCommunityApplicationId = 'old'
    page.data.form.serviceCommunityId = 'old-estate'
    const application = page.applyOrderCommunity()
    requests[0].resolve({ status: 'rejected', outcome: 'rejected', message, rejectionReason: '非公共小区', applicationId: 'rejected' })
    await application
    assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, '')
    assert.equal(page.buildOrderPayload().serviceCommunityId, '')
    assert.equal(page.data.communityApplicationStatus, message || '该小区申请已驳回，不可再次申请：非公共小区')
    assert.doesNotMatch(page.data.communityApplicationStatus, /申请已提交|申请成功|可继续下单/)
    assert.equal(page.data.showCommunityApplication, true)
    assert.equal(page.data.communityApplicationBusy, false)
    assert.equal(requests.length, 1)
  })
}

for (const status of ['existing', 'resolved', 'rejected']) {
  test(`history cannot restore a ${status} application as pending`, async () => {
    const { page, requests } = fixture()
    const loading = page.resetOrderCommunity({ serviceCommunityApplicationId: 'not-pending', orderCommunityApplication: { name: '红瓦小区', status } })
    assert.equal(page.buildOrderPayload().serviceCommunityApplicationId, '')
    assert.equal(page.data.communityApplicationStatus, '')
    requests[0].resolve({ list: [], hasMore: false })
    await loading
  })
}

test('a nearby refresh after an existing application cannot write over a newer address or unloaded page', async () => {
  for (const close of [false, true]) {
    const { page, requests } = fixture()
    page.data.communityApplicationName = '红瓦小区'
    const application = page.applyOrderCommunity()
    requests[0].resolve({ status: 'existing', outcome: 'existing' })
    await application
    if (close) page.onUnload()
    else {
      const next = page.resetOrderCommunity()
      requests[2].resolve({ list: [row('new-address')], hasMore: false })
      await next
    }
    const snapshot = JSON.stringify(page.data)
    requests[1].resolve({ list: [row('late-existing-refresh')], hasMore: false })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    assert.equal(JSON.stringify(page.data), snapshot)
  }
})
