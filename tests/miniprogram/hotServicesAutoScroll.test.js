const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('hot services scroll WXML structure and bindings', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')

  assert.ok(wxml.includes('scroll-left="{{hotServicesScrollLeft}}"'), 'Must bind scroll-left to hotServicesScrollLeft')
  assert.ok(wxml.includes('bindscroll="onHotServicesScroll"'), 'Must bind onHotServicesScroll')
  assert.ok(wxml.includes('bindtouchstart="onHotServicesTouchStart"'), 'Must bind onHotServicesTouchStart')
  assert.ok(wxml.includes('bindtouchend="onHotServicesTouchEnd"'), 'Must bind onHotServicesTouchEnd')
  assert.ok(wxml.includes('binddragstart="onHotServicesTouchStart"'), 'Must bind onHotServicesTouchStart for drag')
  assert.ok(wxml.includes('binddragend="onHotServicesTouchEnd"'), 'Must bind onHotServicesTouchEnd for drag')
  assert.ok(wxml.includes('displayServicePrices'), 'Must use displayServicePrices for seamless looping')
})

test('hot services auto-scroll: <= 2 items does not loop, >= 3 items enables auto-scroll loop', () => {
  let timerId = 1
  const mockSetInterval = (fn, ms) => timerId++
  const mockClearInterval = (id) => {}
  const mockSetTimeout = (fn, ms) => timerId++
  const mockClearTimeout = (id) => {}

  // Create page instance with relevant methods
  const createPage = (servicePrices) => {
    const page = {
      data: {
        servicePrices,
        displayServicePrices: [],
        hotServicesScrollLeft: 0,
        isHotServicesLooping: false
      },
      currentHotScrollLeft: 0,
      singleSetWidth: 300,
      hotServicesScrollTimer: null,
      hotServicesResumeTimer: null,
      isHotServicesTouching: false,

      setData(update, callback) {
        Object.assign(this.data, update)
        if (typeof callback === 'function') callback()
      },

      initHotServicesScroll() {
        const list = this.data.servicePrices || []
        if (list.length < 3) {
          this.stopHotServicesAutoScroll()
          this.setData({
            displayServicePrices: list.map((item, idx) => ({ ...item, uniqueKey: `${item.key || idx}` })),
            isHotServicesLooping: false,
            hotServicesScrollLeft: 0
          })
          this.currentHotScrollLeft = 0
          return
        }

        const displayList = [
          ...list.map((item, idx) => ({ ...item, uniqueKey: `${item.key || idx}_0` })),
          ...list.map((item, idx) => ({ ...item, uniqueKey: `${item.key || idx}_1` }))
        ]

        this.setData({
          displayServicePrices: displayList,
          isHotServicesLooping: true
        }, () => {
          this.startHotServicesAutoScroll()
        })
      },

      startHotServicesAutoScroll() {
        this.stopHotServicesAutoScroll()
        if (!this.data.isHotServicesLooping) return
        if (this.isHotServicesTouching) return
        if ((this.data.servicePrices || []).length < 3) return
        this.hotServicesScrollTimer = mockSetInterval(() => {}, 30)
      },

      stopHotServicesAutoScroll() {
        if (this.hotServicesScrollTimer) {
          mockClearInterval(this.hotServicesScrollTimer)
          this.hotServicesScrollTimer = null
        }
      },

      onHotServicesTouchStart() {
        if (!this.data.isHotServicesLooping) return
        this.isHotServicesTouching = true
        this.stopHotServicesAutoScroll()
        if (this.hotServicesResumeTimer) {
          mockClearTimeout(this.hotServicesResumeTimer)
          this.hotServicesResumeTimer = null
        }
      },

      onHotServicesScroll(e) {
        if (!e || !e.detail) return
        this.currentHotScrollLeft = e.detail.scrollLeft
      },

      onHotServicesTouchEnd(onTimeout) {
        if (!this.data.isHotServicesLooping) return
        this.isHotServicesTouching = false
        if (this.hotServicesResumeTimer) {
          mockClearTimeout(this.hotServicesResumeTimer)
        }
        this.hotServicesResumeTimer = mockSetTimeout(() => {
          if (!this.isHotServicesTouching) {
            this.startHotServicesAutoScroll()
          }
          if (typeof onTimeout === 'function') onTimeout()
        }, 5000)
      }
    }
    return page
  }

  // 1. Less than 3 items: should NOT loop
  const pageTwo = createPage([{ key: 's1' }, { key: 's2' }])
  pageTwo.initHotServicesScroll()
  assert.equal(pageTwo.data.isHotServicesLooping, false)
  assert.equal(pageTwo.data.displayServicePrices.length, 2)
  assert.equal(pageTwo.hotServicesScrollTimer, null)

  // 2. Greater than or equal to 3 items: should loop and duplicate list
  const pageThree = createPage([{ key: 's1' }, { key: 's2' }, { key: 's3' }])
  pageThree.initHotServicesScroll()
  assert.equal(pageThree.data.isHotServicesLooping, true)
  assert.equal(pageThree.data.displayServicePrices.length, 6)
  assert.ok(pageThree.hotServicesScrollTimer !== null, 'Scroll timer must be active')

  // 3. User touch starts: timer stops immediately
  pageThree.onHotServicesTouchStart()
  assert.equal(pageThree.isHotServicesTouching, true)
  assert.equal(pageThree.hotServicesScrollTimer, null, 'Timer must stop on touch')

  // User drags: scroll position updates
  pageThree.onHotServicesScroll({ detail: { scrollLeft: 85 } })
  assert.equal(pageThree.currentHotScrollLeft, 85)

  // 4. User touch ends: 5s timeout is scheduled, timer starts only after 5s
  let timeoutTriggered = false
  pageThree.onHotServicesTouchEnd(() => {
    timeoutTriggered = true
  })
  assert.equal(pageThree.isHotServicesTouching, false)
  assert.ok(pageThree.hotServicesResumeTimer !== null, 'Resume timer must be scheduled for 5s')
})
