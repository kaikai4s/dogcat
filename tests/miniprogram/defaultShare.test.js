const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const appSource = fs.readFileSync(path.join(__dirname, '../../miniprogram/app.js'), 'utf8')

function registerPages() {
  const pages = []
  const redirects = []
  const context = {
    Page(options) { pages.push(options); return options },
    App() {},
    wx: { reLaunch(options) { redirects.push(options.url) } },
    require(name) {
      if (name.endsWith('/adminAccess')) return { installAdminPageGuard() {} }
      if (name.endsWith('/page-share')) return require(path.join(__dirname, '../../miniprogram/utils/page-share'))
      return {}
    }
  }
  vm.runInNewContext(appSource, context)
  return { pages, redirects, register: context.Page }
}

test('pages without custom sharing forward to the public home instead of their current route', () => {
  const { pages, register } = registerPages()
  register({ data: {}, onShow() {} })
  assert.equal(pages.length, 1)
  const share = pages[0].onShareAppMessage.call({ route: 'pages/admin/finance/index' })
  assert.equal(share.path, '/pages/client/home/index')
  assert.match(share.title, /多芙琳/)
})

test('existing campaign share destinations remain unchanged', () => {
  const { pages, register } = registerPages()
  const custom = () => ({ title: '活动邀请', path: '/pages/client/pet-beauty/activity/index?inviteCode=abc' })
  register({ onShareAppMessage: custom })
  const share = pages[0].onShareAppMessage.call({ route: 'pages/client/pet-beauty/activity/index' })
  assert.equal(share.title, '活动邀请')
  assert.equal(share.path, '/pages/client/pet-beauty/activity/index?inviteCode=abc')
  assert.equal(share.imageUrl, '/images/share-default.png')
})

test('every page exposes a timeline handler and private timeline entries go home', () => {
  const { pages, register } = registerPages()
  register({ data: {} })
  const timeline = pages[0].onShareTimeline.call({ route: 'pages/admin/finance/index' })
  assert.equal(timeline.query, 'sharedHome=1')
  assert.equal(timeline.imageUrl, '/images/share-default.png')
})

test('a private timeline landing redirects before the page loads', () => {
  const { pages, redirects, register } = registerPages()
  let loaded = false
  register({ onLoad() { loaded = true } })
  const page = { route: 'pages/admin/finance/index' }
  pages[0].onLoad.call(page, { sharedHome: '1' })
  assert.equal(loaded, false)
  assert.deepEqual(redirects, ['/pages/client/home/index'])
})

test('admin guard redirects a private timeline landing before checking access', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/adminAccess.js'), 'utf8')
  const pages = [], redirects = []
  let loaded = false
  const context = {
    module: { exports: {} },
    Page(options) { pages.push(options) },
    wx: { reLaunch(options) { redirects.push(options.url) } }
  }
  vm.runInNewContext(source, context)
  context.module.exports.installAdminPageGuard()
  context.Page({ onLoad() { loaded = true }, onShow() { loaded = true } })
  const page = { route: 'pages/admin/finance/index' }
  pages[0].onLoad.call(page, { sharedHome: '1' })
  pages[0].onShow.call(page)
  assert.equal(loaded, false)
  assert.deepEqual(redirects, ['/pages/client/home/index'])
})
