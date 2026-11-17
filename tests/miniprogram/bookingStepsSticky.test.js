const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const createDir = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create')

function loadCreatePage() {
  let page
  const scrollCalls = []
  let viewportScrollTop = 0
  let anchorInitialTop = 140
  let cardRects = [
    { id: 'booking-step-1', top: 196 },
    { id: 'booking-step-2', top: 520 },
    { id: 'booking-step-3', top: 880 },
    { id: 'booking-step-4', top: 1200 },
    { id: 'booking-step-5', top: 1520 },
    { id: 'booking-step-6', top: 1900 }
  ]

  const wx = {
    getStorageSync: () => null,
    cloud: {},
    pageScrollTo(options) {
      scrollCalls.push(options)
      const matched = cardRects.find((card) => `#${card.id}` === options.selector)
      if (matched) {
        const offset = Number(options.offsetTop) || 0
        viewportScrollTop = Math.max(0, matched.top + offset)
        page.onPageScroll({ scrollTop: viewportScrollTop })
      }
    },
    createSelectorQuery() {
      const queue = []
      const api = {
        in() { return api },
        select(selector) { queue.push({ type: 'select', selector }); return api },
        selectAll(selector) { queue.push({ type: 'selectAll', selector }); return api },
        selectViewport() { queue.push({ type: 'viewport' }); return api },
        boundingClientRect() { return api },
        scrollOffset() { return api },
        exec(cb) {
          const result = queue.map((item) => {
            if (item.type === 'viewport') return { scrollTop: viewportScrollTop }
            if (item.selector === '#booking-steps-anchor') {
              return { top: anchorInitialTop - viewportScrollTop, height: 44 }
            }
            if (item.selector === '.booking-step-card') {
              return cardRects.map((card) => ({ id: card.id, top: card.top - viewportScrollTop }))
            }
            return null
          })
          if (cb) cb(result)
        }
      }
      return api
    }
  }

  const format = require('../../miniprogram/utils/format')
  const deps = {
    loadSystemSettings: async () => ({}),
    getCachedSystemSettings: () => ({}),
    getCurrentUser: async () => ({ _id: 'user' }),
    ensureLogin: async () => ({ _id: 'user' }),
    applyTheme: () => ({ value: 'day' }),
    getThemeState: () => ({}),
    getSelectedLocation: () => null,
    toBeijingDate: format.toBeijingDate,
    parseBeijingDate: format.parseBeijingDate,
    showError() {},
    callFunction: async () => []
  }

  const navModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/utils/nav.js'), 'utf8'), {
    module: navModule,
    require: () => ({ getRoleHome: () => '/pages/client/home/index' }),
    wx,
    getCurrentPages: () => [{ route: 'pages/client/orders/create/index' }]
  })

  vm.runInNewContext(fs.readFileSync(path.join(createDir, 'index.js'), 'utf8'), {
    Page(config) { page = config },
    require: (name) => name.endsWith('/nav') ? navModule.exports : deps,
    wx,
    getCurrentPages: () => [{ route: 'pages/client/orders/create/index' }],
    console: { error() {}, warn() {} },
    setTimeout,
    clearTimeout
  })

  page.setData = function (updates, callback) {
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
    if (callback) callback.call(this)
  }

  return {
    page,
    scrollCalls,
    setViewportScrollTop(top) { viewportScrollTop = top },
    setAnchorTop(top) { anchorInitialTop = top }
  }
}

test('booking step bar uses fixed top bar without horizontal clipping in WXML and WXSS', () => {
  const wxml = fs.readFileSync(path.join(createDir, 'index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(createDir, 'index.wxss'), 'utf8')

  assert.ok(wxml.includes('id="booking-steps-anchor" class="booking-steps-anchor"'))
  assert.ok(wxml.includes('class="booking-steps-bar {{bookingStepsFixed ? \'is-fixed\' : \'\'}}"'))
  assert.ok(wxml.includes('scroll-into-view="{{bookingStepScrollTarget}}"'))
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(wxml.includes(`id="booking-step-pill-${i}"`), `missing pill ${i}`)
    assert.ok(wxml.includes(`id="booking-step-${i}"`), `missing step section ${i}`)
  }

  assert.match(wxss, /\.booking-steps-anchor\s*\{[\s\S]*?height:\s*86rpx/)
  assert.match(wxss, /\.booking-steps-bar\.is-fixed\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*0;/)
  assert.ok(!/\.booking-steps-bar\s*\{[^}]*margin:\s*-10rpx -28rpx/.test(wxss))
})

test('booking step bar locks at top on scroll and keeps tapped steps clickable after scrolling', async () => {
  const { page, scrollCalls, setViewportScrollTop } = loadCreatePage()
  page.onLoad()
  await page.onShow()
  page.measureBookingStepsAnchor(true)

  assert.equal(page.data.bookingStepsFixed, false)

  setViewportScrollTop(60)
  page.onPageScroll({ scrollTop: 60 })
  assert.equal(page.data.bookingStepsFixed, false)

  setViewportScrollTop(140)
  page.onPageScroll({ scrollTop: 140 })
  assert.equal(page.data.bookingStepsFixed, true)

  page.scrollToBookingStep({ currentTarget: { dataset: { step: '5' } } })
  assert.equal(page.data.activeBookingStep, 5)
  assert.equal(page.data.bookingStepScrollTarget, 'booking-step-pill-5')
  assert.equal(page.data.bookingStepsFixed, true)
  assert.equal(scrollCalls[0].selector, '#booking-step-5')
  assert.ok(scrollCalls[0].offsetTop < -44)

  // Clicking another pill while fixed still jumps accurately and stays fixed.
  page.scrollToBookingStep({ currentTarget: { dataset: { step: '2' } } })
  assert.equal(page.data.activeBookingStep, 2)
  assert.equal(page.data.bookingStepsFixed, true)
  assert.equal(scrollCalls[1].selector, '#booking-step-2')

  // Scrolling back above the hero unfixes the step bar into normal flow.
  setViewportScrollTop(20)
  page.onPageScroll({ scrollTop: 20 })
  assert.equal(page.data.bookingStepsFixed, false)

  page.onUnload()
})
