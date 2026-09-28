const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const cardStyle = require('../../miniprogram/utils/profileCardStyle')

function loadPage(file, callFunction = async () => ({})) {
  let page
  const scrolls = []
  const timers = new Map()
  let timerId = 0
  const deps = {
    ...require('../../miniprogram/utils/format'),
    callFunction, showError: (error) => { throw error },
    createPageNav: () => ({}), navMethods: () => ({}),
    loadSystemSettings: async () => ({}), getSelectedLocation: () => null
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram', file), 'utf8'), {
    Page(config) { page = config },
    require: (name) => name.endsWith('/profileCardStyle') ? cardStyle : deps,
    wx: { pageScrollTo: (options) => scrolls.push(options), showToast() {} },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId },
    clearTimeout(id) { timers.delete(id) }, console
  })
  page.setData = function (updates, callback) {
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
    if (callback) callback.call(this)
  }
  return { page, scrolls, timers }
}

const bookingFile = 'pages/client/orders/create/index.js'
const tap = (key, value) => ({ currentTarget: { dataset: { [key]: value } } })
const dog = { _id: 'dog', name: '狗狗', species: 'dog' }
const cat = { _id: 'cat', name: '猫咪', species: 'cat' }
const options = [{ key: 'walk' }, { key: 'feed' }, { key: 'play' }]

async function booking(pets, query = {}) {
  const result = loadPage(bookingFile, async (_, action) => {
    if (action === 'listPets') return pets
    if (action === 'listServiceOptions') return options
    return {}
  })
  result.page.prepareTime = function () { this.syncPetServiceDurations() }
  result.page.fetchAiPetVoice = () => {}
  result.page.loadDefaultAddress = () => {}
  result.page.resolveServiceCaseUrls = () => {}
  result.page.onLoad(query)
  await result.page.loadPageData()
  return result
}

test('walk defaults depend on selected pets, including unknown species and an unselected dog', async () => {
  for (const pets of [[], [cat], [{ _id: 'unknown' }], [cat, dog]]) {
    const { page } = await booking(pets)
    assert.equal(page.data.form.serviceTypes.includes('walk'), false)
  }
  const { page } = await booking([dog, cat])
  assert.equal(page.data.form.serviceTypes.includes('walk'), true)
  assert.equal(page.data.petDurationRows.length, 1)
  assert.equal(page.data.petDurationRows[0].petId, 'dog')
})

test('pet selection adds walk for a dog and removes it and its durations when the last dog is removed', async () => {
  const { page } = await booking([cat, dog])
  page.toggleService(tap('key', 'feed'))
  page.choosePet(tap('id', 'dog'))
  assert.equal(page.data.form.serviceTypes.includes('walk'), true)
  assert.equal(page.data.form.serviceTypes.includes('feed'), true)
  page.choosePet(tap('id', 'dog'))
  assert.equal(page.data.form.serviceTypes.includes('walk'), false)
  assert.equal(page.data.form.serviceTypes.includes('feed'), true)
  assert.equal(page.data.form.petServiceDurations.length, 0)
  page.toggleService(tap('key', 'walk'))
  assert.equal(page.data.form.serviceTypes.includes('walk'), false)
  assert.match(page.data.bookingNotice, /至少选择一只狗狗/)
})

test('manual deselection and an explicit feed entry survive refresh', async () => {
  const { page } = await booking([dog, cat])
  page.toggleService(tap('key', 'walk'))
  page.choosePet(tap('id', 'cat'))
  await page.loadPageData()
  assert.equal(page.data.form.serviceTypes.includes('walk'), false)
  const explicit = await booking([dog], { serviceType: 'feed' })
  assert.equal(explicit.page.data.form.serviceTypes.includes('walk'), false)
  assert.equal(explicit.page.data.form.serviceTypes.includes('feed'), true)
})

test('missing agreement blocks submission, displays the full notice and scrolls to consent without checking it', () => {
  const { page, scrolls, timers } = loadPage(bookingFile)
  page.prepareTime = () => assert.fail('must not submit without agreement')
  page.create()
  assert.equal(page.data.bookingNotice, '请先阅读并勾选同意服务保障协议与取消规则')
  assert.equal(page.data.agreeAgreement, false)
  assert.equal(page.data.agreementRequired, true)
  assert.equal(scrolls[0].selector, '#booking-agreement')
  page.toggleAgreement()
  assert.equal(page.data.agreeAgreement, true)
  assert.equal(page.data.agreementRequired, false)
  assert.equal(page.data.bookingNotice, '')
  assert.equal(timers.size, 0)
})

test('long scheduling messages remain complete, replace old messages and clean up on unload', () => {
  const { page, timers } = loadPage(bookingFile)
  const title = '2026-09-28 预约时间不在接单时段（08:00-22:00）内，请修改时间'
  page.showBookingNotice({ title: '旧提示' })
  page.showBookingNotice({ title })
  assert.equal(page.data.bookingNotice, title)
  assert.equal(timers.size, 1)
  page.onUnload()
  assert.equal(timers.size, 0)
})

test('card customization restores saved values, previews opacity separately from text and saves', async () => {
  let saved
  const { page } = loadPage('pages/staff/profile/index.js', async (_, action, data) => {
    if (action === 'updateStaffProfileConfig') saved = data
  })
  page.loadProfile = () => {}
  page.data.profile = {
    serviceAddress: '服务驿站', serviceLatitude: 31, serviceLongitude: 121,
    profileCardColor: '#123456', profileCardOpacity: 0, profileCardTextColor: '#ffffff'
  }
  page.openConfigModal()
  assert.equal(page.data.configForm.profileCardOpacity, 0)
  assert.match(page.data.profileCardStyle, /rgba\(18,52,86,0\)/)
  assert.match(page.data.profileCardStyle, /color: #ffffff/)
  page.changeCardOpacity({ detail: { value: 100 } })
  assert.match(page.data.profileCardStyle, /rgba\(18,52,86,1\)/)
  page.saveConfig()
  await Promise.resolve()
  assert.equal(saved.profileCardOpacity, 100)
  assert.equal(saved.profileCardTextColor, '#ffffff')
})

test('public card renders saved styling and old or malformed profiles receive safe defaults', async () => {
  const profile = { profileCardColor: '#000000', profileCardOpacity: 25, profileCardTextColor: '#ffffff' }
  const { page } = loadPage('pages/client/sitters/detail/index.js', async () => profile)
  page.data.id = 'sitter'
  page.load()
  await Promise.resolve()
  assert.match(page.data.profileCardStyle, /rgba\(0,0,0,0.25\)/)
  assert.equal(page.data.sitter.profileCardTextColor, '#ffffff')
  assert.deepEqual(cardStyle.normalizeCardStyle({}), cardStyle.DEFAULT_CARD_STYLE)
  assert.deepEqual(cardStyle.normalizeCardStyle({ profileCardColor: 'red;display:none', profileCardOpacity: null }), cardStyle.DEFAULT_CARD_STYLE)
})
