const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.resolve(__dirname, '../../miniprogram/packagePlayground/pages/manor3d-entry.js'),
  'utf8'
)

function fixture({ navigationThrows = false, storageThrows = false } = {}) {
  let definition
  let resolveSelection, rejectSelection
  let chooserCalls = 0
  const storage = new Map()
  const removed = []
  const navigations = []
  const errors = []
  let closeChooser = () => {}
  vm.runInNewContext(source, {
    Page: value => { definition = value },
    Date,
    Math,
    wx: {
      setStorageSync(key, value) {
        if (storageThrows) throw new Error('storage unavailable')
        storage.set(key, value)
      },
      removeStorageSync(key) { removed.push(key); storage.delete(key) },
      navigateTo(options) {
        if (navigationThrows) throw new Error('navigation unavailable')
        navigations.push(options)
      },
      navigateBack() {},
      showToast: value => errors.push(value.title)
    }
  })
  const page = {
    ...definition,
    data: { ...definition.data },
    setData(values) { Object.assign(this.data, values) },
    selectComponent(id) {
      assert.equal(id, '#communityChooser')
      return {
        open() {
          chooserCalls++
          return new Promise((resolve, reject) => {
            resolveSelection = resolve
            rejectSelection = reject
            closeChooser = () => reject({ errMsg: 'chooseCommunity:fail cancel' })
          })
        },
        close() { closeChooser() }
      }
    }
  }
  page.onLoad()
  return {
    page,
    storage,
    removed,
    navigations,
    errors,
    chooserCalls: () => chooserCalls,
    resolveSelection: value => resolveSelection(value),
    rejectSelection: error => rejectSelection(error)
  }
}

test('a community selection is passed through a short one-time key without saving a residence', async () => {
  const f = fixture()
  const community = {
    name: '青溪花园',
    serviceCommunityId: 'map_community_0123456789abcdef01234567',
    city: '杭州市'
  }
  const entering = f.page.chooseCommunity()
  assert.equal(f.chooserCalls(), 1)
  f.resolveSelection(community)
  await entering

  assert.equal(f.storage.size, 1)
  const [[key, payload]] = [...f.storage]
  const entryKey = key.slice('manor3d:entry:'.length)
  assert.ok(entryKey.length > 0 && entryKey.length < 32)
  assert.equal(JSON.stringify(payload.community), JSON.stringify(community))
  assert.ok(Number.isFinite(payload.createdAt))
  assert.equal(f.navigations.length, 1)
  assert.equal(f.navigations[0].url, '/packageManor3d/pages/index?entryKey=' + encodeURIComponent(entryKey))
  assert.ok(!f.navigations[0].url.includes(community.name))
  assert.ok(!source.includes('saveCommunity'))
})

test('canceling the chooser leaves the page open without a route ticket', async () => {
  const f = fixture()
  const entering = f.page.chooseCommunity()
  f.rejectSelection({ errMsg: 'chooseCommunity:fail cancel' })
  await entering

  assert.equal(f.storage.size, 0)
  assert.equal(f.navigations.length, 0)
  assert.equal(f.page.data.opening, false)
  assert.equal(f.page.data.error, '')
})

test('hiding the page cancels a pending community choice', async () => {
  const f = fixture()
  const entering = f.page.chooseCommunity()
  f.page.onHide()
  await entering
  assert.equal(f.storage.size, 0)
  assert.equal(f.navigations.length, 0)
  assert.equal(f.page.data.opening, false)
})

test('the solo entry passes an explicit null community', () => {
  const f = fixture()
  f.page.enterSolo()

  assert.equal(f.chooserCalls(), 0)
  assert.equal(f.storage.size, 1)
  const [[key, payload]] = [...f.storage]
  const entryKey = key.slice('manor3d:entry:'.length)
  assert.equal(payload.community, null)
  assert.equal(f.navigations[0].url, '/packageManor3d/pages/index?entryKey=' + encodeURIComponent(entryKey))
})

test('failed storage or navigation never leaves an unusable route ticket', () => {
  const storageFailure = fixture({ storageThrows: true })
  storageFailure.page.enterSolo()
  assert.equal(storageFailure.navigations.length, 0)
  assert.equal(storageFailure.page.data.opening, false)
  assert.match(storageFailure.page.data.error, /无法准备/)

  const navigationFailure = fixture({ navigationThrows: true })
  navigationFailure.page.enterSolo()
  assert.equal(navigationFailure.storage.size, 0)
  assert.equal(navigationFailure.removed.length, 1)
  assert.equal(navigationFailure.page.data.opening, false)
  assert.match(navigationFailure.page.data.error, /无法打开/)
})
