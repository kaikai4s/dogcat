const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/page-share.js'), 'utf8')

function fixture(initialCover = '') {
  let imageUrl = initialCover
  const menus = []
  const cloudFiles = []
  const exports = { exports: {} }
  const wx = {
    showShareMenu(options) { menus.push(options.menus) },
    cloud: { getTempFileURL(options) {
      cloudFiles.push(options.fileList[0])
      options.success({ fileList: [{ tempFileURL: 'https://example.test/general-cover.jpg' }] })
      options.complete()
    } }
  }
  vm.runInNewContext(source, {
    module: exports,
    require() { return {
      getCachedSystemSettings: () => ({ generalShare: { imageUrl } }),
      loadSystemSettings: async () => ({ generalShare: { imageUrl } }),
      getCloudEnv: () => 'test-env'
    } },
    wx, Date, Set
  })
  return { share: exports.exports, menus, cloudFiles, setCover(value) { imageUrl = value } }
}

test('general cover is preloaded and used for friend and timeline sharing', () => {
  const { share, menus, cloudFiles } = fixture('cloud://test/general_share/cover.jpg')
  share.prepareShareMenu()
  const publicPage = { route: 'pages/client/mall/detail/index', data: { id: 'product 1' } }
  const friend = share.decorateAppMessage(publicPage, share.publicTarget(publicPage))
  const timeline = share.decorateTimeline(publicPage, null)
  assert.equal(friend.path, '/pages/client/mall/detail/index?id=product%201')
  assert.equal(timeline.query, 'id=product%201')
  assert.equal(friend.imageUrl, 'https://example.test/general-cover.jpg')
  assert.equal(timeline.imageUrl, friend.imageUrl)
  assert.deepEqual(Array.from(menus[0]), ['shareAppMessage', 'shareTimeline'])
  assert.deepEqual(cloudFiles, ['cloud://test/general_share/cover.jpg'])
})

test('private pages use public landing for friend and timeline shares', () => {
  const { share } = fixture()
  const page = { route: 'pages/staff/orders/detail/index', data: { id: 'private-order' } }
  assert.equal(share.decorateAppMessage(page, share.publicTarget(page)).path, '/pages/client/home/index')
  assert.equal(share.decorateTimeline(page, null).query, 'sharedHome=1')
  assert.equal(share.shouldRedirectSharedHome(page, { sharedHome: '1' }), true)
  assert.equal(share.shouldRedirectSharedHome({ route: 'pages/client/home/index' }, { sharedHome: '1' }), false)
})

test('check-in and invitation keep their own cover and invitation query', () => {
  const { share } = fixture('https://example.test/general.jpg')
  for (const route of ['pages/client/checkin/index', 'pages/client/profile/assets/index']) {
    const page = { route }
    const campaign = () => ({ title: '活动分享', path: `/${route}?inviteCode=mine`, imageUrl: 'cloud://test/campaign.jpg' })
    assert.equal(share.decorateAppMessage(page, campaign()).imageUrl, 'cloud://test/campaign.jpg')
    const timeline = share.decorateTimeline(page, null, campaign)
    assert.equal(timeline.imageUrl, 'cloud://test/campaign.jpg')
    assert.equal(timeline.query, 'inviteCode=mine')
  }
})
