const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '../../miniprogram')
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const carousel = (fileId = 'cloud://hero') => ({ enabled: true, items: [{ id: 'first', fileId, type: 'image', linkUrl: '/pages/client/mall/list/index' }] })

function setup({ storage = {}, cached = {}, resolveFiles, now = { value: Date.now() } } = {}) {
  const settings = deferred()
  const home = deferred()
  const calls = []
  const fileRequests = []
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
    cloud: { getTempFileURL(options) {
      fileRequests.push(options)
      if (resolveFiles) resolveFiles(options)
      else options.success({ fileList: options.fileList.map(fileID => ({ fileID, tempFileURL: `https://cdn/${fileID.slice(8)}` })) })
    } },
    stopPullDownRefresh() { calls.push('stopRefresh') }
  }
  const mediaModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/hero-media.js'), 'utf8'), {
    module: mediaModule, wx, Date: { now: () => now.value }, require: () => ({ getCloudEnv: () => 'test-env' })
  })
  const deps = {
    getSelectedLocation: () => null, getCachedSystemSettings: () => cached,
    refreshHomeSubscriptionReminder: async () => {}, invalidateHomeSubscriptionReminder: () => {},
    loadSystemSettings: () => { calls.push('settings'); return settings.promise },
    callFunction: (_, action) => { calls.push(action); return home.promise },
    getCurrentUser: async () => null, loadMessageUnread: () => {}, startStaffEntryUnread() {}, stopStaffEntryUnread() {},
    applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}), showError: () => {}
  }
  let page
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/client/home/index.js'), 'utf8'), {
    Page(config) { page = config }, wx, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name.endsWith('/hero-media') ? mediaModule.exports : deps
  })
  page.setData = function (data, callback) { Object.assign(this.data, data); if (callback) callback.call(this) }
  page.loadLottery = () => {}
  return { page, settings, home, calls, fileRequests, media: mediaModule.exports, storage, now }
}

test('home loads hero independently while the aggregate home request is still pending', async () => {
  const ctx = setup()
  ctx.page.onShow()
  assert.equal(ctx.page.data.heroLoading, true)
  assert.ok(ctx.calls.includes('getHomePageData'))
  ctx.settings.resolve({ homeHeroCarousel: carousel() })
  await flush()
  assert.equal(ctx.page.data.heroSlides[0].url, 'https://cdn/hero')
  assert.equal(ctx.page.data.heroLoading, false)
  ctx.home.resolve({ settings: { homeHeroCarousel: { enabled: false } } })
  await flush()
  assert.equal(ctx.page.data.heroCarouselEnabled, true, 'a slow aggregate response cannot overwrite fresh hero settings')
})

test('home notices and maintenance cannot be overwritten by an older settings response', async () => {
  const newerHome = setup()
  newerHome.page.loadHeroCarousel()
  newerHome.page.loadHomePageData()
  newerHome.home.resolve({ settings: { noticeTicker: { enabled: true, items: ['新公告'] }, maintenance: { booking: true } } })
  await flush()
  newerHome.settings.resolve({ noticeTicker: { enabled: true, items: ['旧公告'] }, maintenance: { booking: false }, homeHeroCarousel: {} })
  await flush()
  assert.equal(newerHome.page.data.noticeTicker.items[0], '新公告')
  assert.equal(newerHome.page.data.maintenance.booking, true)

  const newerSettings = setup()
  newerSettings.page.loadHomePageData()
  newerSettings.page.loadHeroCarousel()
  newerSettings.settings.resolve({ noticeTicker: { enabled: true, items: ['新公告'] }, maintenance: { booking: true }, homeHeroCarousel: {} })
  await flush()
  newerSettings.home.resolve({ settings: { noticeTicker: { enabled: true, items: ['旧公告'] }, maintenance: { booking: false } } })
  await flush()
  assert.equal(newerSettings.page.data.noticeTicker.items[0], '新公告')
  assert.equal(newerSettings.page.data.maintenance.booking, true)
})

test('a recreated home displays reusable signed URLs synchronously and keeps links before refreshing', async () => {
  const storage = {}
  const first = setup({ storage })
  await first.page.applyHeroCarousel(carousel())
  const next = setup({ storage, cached: { homeHeroCarousel: carousel() } })
  next.page.onShow()
  assert.equal(next.page.data.heroSlides[0].url, 'https://cdn/hero')
  assert.equal(next.page.data.heroSlides[0].linkUrl, '/pages/client/mall/list/index')
  assert.equal(next.fileRequests.length, 0)
  next.settings.resolve({ homeHeroCarousel: carousel() })
  await flush()
  assert.equal(next.fileRequests.length, 0)
})

test('new configuration and disabling hero supersede pending media without resurrecting old slides', async () => {
  const ctx = setup({ resolveFiles: () => {} })
  const old = ctx.page.applyHeroCarousel(carousel())
  ctx.page.applyHeroCarousel({ enabled: false })
  ctx.fileRequests[0].success({ fileList: [{ fileID: 'cloud://hero', tempFileURL: 'https://cdn/old' }] })
  await old
  assert.equal(ctx.page.data.heroSlides.length, 0)
  const next = ctx.page.applyHeroCarousel(carousel('cloud://new'))
  ctx.fileRequests[1].success({ fileList: [{ fileID: 'cloud://new', tempFileURL: 'https://cdn/new' }] })
  await next
  assert.equal(ctx.page.data.heroSlides[0].url, 'https://cdn/new')
})

test('expired URL cache refreshes; direct HTTPS resources never request cloud URL conversion', async () => {
  const ctx = setup()
  await ctx.media.resolveHeroMedia(['cloud://hero'])
  ctx.now.value += 11 * 60 * 1000
  assert.equal(Object.keys(ctx.media.getCachedHeroMedia(['cloud://hero'])).length, 0)
  await ctx.media.resolveHeroMedia(['cloud://hero'])
  assert.equal(ctx.fileRequests.length, 2)
  const urls = await ctx.media.resolveHeroMedia(['https://cdn/direct'])
  assert.equal(urls['https://cdn/direct'], 'https://cdn/direct')
  assert.equal(ctx.fileRequests.length, 2)
})

test('media errors refresh signed URLs at most once per slide, and temporary failures retain visible media', async () => {
  const ctx = setup()
  await ctx.page.applyHeroCarousel(carousel())
  const event = { currentTarget: { dataset: { id: 'first', url: 'https://cdn/hero' } } }
  ctx.page.onHeroMediaError(event)
  await flush()
  ctx.page.onHeroMediaError(event)
  assert.equal(ctx.fileRequests.length, 2)
  const failed = setup({ resolveFiles: options => options.fail() })
  failed.page.setData({ heroCarouselEnabled: true, heroSlides: [{ id: 'old', url: 'https://cdn/old' }] })
  await failed.page.applyHeroCarousel(carousel())
  assert.equal(failed.page.data.heroSlides[0].url, 'https://cdn/old')
})

test('leaving the home invalidates outstanding settings and pull-down refresh always finishes', async () => {
  const ctx = setup()
  ctx.page.onShow()
  ctx.page.onHide()
  ctx.settings.resolve({ homeHeroCarousel: carousel() })
  await flush()
  assert.equal(ctx.fileRequests.length, 0)
  ctx.home.resolve({ settings: {} })
  await ctx.page.onPullDownRefresh()
  assert.ok(ctx.calls.includes('stopRefresh'))
})

test('home service price cards have uniform height and clamp long title text', () => {
  const wxss = fs.readFileSync(path.join(root, 'pages/client/home/index.wxss'), 'utf8')
  assert.match(wxss, /\.service-price-card,\s*\.sitter-home-card\s*\{[^}]*padding:\s*24rpx;[^}]*background:\s*linear-gradient\(180deg, #ffffff 0%, #fffaf4 100%\);[^}]*border:\s*1rpx solid rgba\(255, 153, 102, 0\.14\);/s)
  assert.doesNotMatch(wxss, /\.service-price-card,\s*\.featured-sitters-heading/)
  assert.match(wxss, /\.service-price-card\s*\{[^}]*height:\s*420rpx;/)
  assert.match(wxss, /\.service-price-card\s*\{[^}]*flex-direction:\s*column;/)
  assert.match(wxss, /\.service-price-name\s*\{[^}]*height:\s*76rpx;/)
  assert.match(wxss, /\.service-price-name\s*\{[^}]*-webkit-line-clamp:\s*2;/)
  assert.match(wxss, /\.service-price-text\s*\{[^}]*margin-top:\s*auto;/)
})

test('newbie coupon action stays inside narrow scroll cards without native button minimum sizing', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/client/home/index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(root, 'pages/client/home/index.wxss'), 'utf8')
  assert.match(wxml, /<view class="coupon-claim-btn [^\"]*"[^>]*bindtap="claimNewbieCoupon"><text class="coupon-claim-label">/)
  assert.doesNotMatch(wxml, /<button class="coupon-claim-btn/)
  assert.match(wxss, /\.coupon-claim-btn\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/)
  assert.match(wxss, /\.coupon-claim-label\s*\{[^}]*max-width:\s*100%;[^}]*text-overflow:\s*ellipsis;/)
})

test('home only shows real newbie coupons and keeps the fixed card layout', async () => {
  const pageScript = fs.readFileSync(path.join(root, 'pages/client/home/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/client/home/index.wxml'), 'utf8')
  assert.doesNotMatch(pageScript, /couponPreview|NEWBIE_COUPON_PREVIEW|canPreviewNewbieCoupons/)
  assert.doesNotMatch(wxml, /预览效果|开发版样式预览/)
  assert.match(wxml, /wx:if="\{\{homePage\.modules\.newbieCoupon && coupons\.length\}\}"/)
  assert.match(wxml, /class="coupon-claim-btn [^\"]*"[^>]*bindtap="claimNewbieCoupon"/)

  const empty = setup()
  empty.page.onShow()
  assert.equal(empty.page.data.coupons.length, 0)
  empty.home.resolve({ settings: {}, coupons: [] })
  await flush()
  assert.equal(empty.page.data.coupons.length, 0)

  const real = setup()
  real.page.loadHomePageData()
  real.home.resolve({ settings: {}, coupons: [{ _id: 'real-coupon', name: '新人券', discountAmount: 10 }] })
  await flush()
  assert.equal(real.page.data.coupons.length, 1)
  assert.equal(real.page.data.coupons[0]._id, 'real-coupon')
})

