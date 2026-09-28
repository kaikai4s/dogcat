const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const color = require('../../miniprogram/pages/staff/components/color-picker/color')
const { buildCardStyle } = require('../../miniprogram/pages/staff/utils/profileCardStyle')

test('continuous palette covers primaries, arbitrary colors, black and white without a fixed swatch list', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#5793c7', '#deadbe', '#123456']) {
    const { h, s, v } = color.hexToHsv(hex)
    assert.equal(color.hsvToHex(h, s, v), hex)
  }
  assert.equal(color.hsvToHex(360, 100, 100), '#ff0000')
  assert.equal(color.hexToHsv('#000000', 120).h, 120)
})

test('opacity changes continuously at 0/1% and never switches blur on or off', () => {
  for (const blur of [0, 1, 50, 100]) {
    for (const opacity of [0, 1, 2, 50, 100]) {
      const style = buildCardStyle({ profileCardOpacity: opacity, profileCardBlur: blur })
      assert.ok(style.includes(`rgba(255,255,255,${opacity / 100})`))
      assert.ok(style.includes(`blur(${(blur * 0.24).toFixed(2)}rpx)`))
      assert.doesNotMatch(style, /backdrop-filter: none/)
    }
  }
})

test('touch palette reads mobile viewport coordinates and emits the selected color', () => {
  let component
  const source = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/components/color-picker/index.js'), 'utf8')
  vm.runInNewContext(source, { require: () => color, Component(config) { component = config } })
  const changes = []
  const picker = { ...component.methods, data: { ...component.data }, setData(data) { Object.assign(this.data, data) }, triggerEvent(_, data) { changes.push(data.value) } }
  picker.createSelectorQuery = () => ({ select() { return this }, boundingClientRect(fn) { fn({ left: 20, top: 100, width: 200, height: 100 }); return this }, exec() {} })
  picker.startPicking({ touches: [{ clientX: 220, clientY: 100 }] })
  assert.equal(changes.at(-1), '#ff0000')
  picker.changeHue({ detail: { value: 120 } })
  assert.equal(changes.at(-1), '#00ff00')
  picker.endPicking({ changedTouches: [{ clientX: 20, clientY: 100 }] })
  assert.equal(changes.at(-1), '#ffffff')
})

test('tapping the card toggles the inline homepage expansion and preserves card styling', () => {
  let page
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/sitters/detail/index.js'), 'utf8'), {
    require: () => ({ navMethods: () => ({}) }), Page(config) { page = config }, wx: { previewImage() { assert.fail('homepage expansion must stay inline') } }
  })
  page.setData = (update) => Object.assign(page.data, update)
  page.toggleHeroExpand()
  assert.equal(page.data.heroExpanded, false)
  page.data.sitter = { profileBackgroundFileId: 'cloud://photo' }
  page.data.profileCardStyle = buildCardStyle({ profileCardOpacity: 20, profileCardBlur: 30 })
  const style = page.data.profileCardStyle
  page.toggleHeroExpand()
  assert.equal(page.data.heroExpanded, true)
  assert.equal(page.data.profileCardStyle, style)
  page.toggleHeroExpand()
  assert.equal(page.data.heroExpanded, false)
  page.toggleHeroExpand()
  assert.equal(page.data.heroExpanded, true, 'rapid toggles remain reversible without animation locks')
})

test('hero measurements reserve enough space for long text and adapt on screen resize', () => {
  let page
  let viewport = { width: 375, height: 800 }
  const query = {
    in() { return this }, select() { return this }, boundingClientRect() { return this },
    selectViewport() { return this }, fields() { return this },
    exec(callback) { callback([{}, { height: 410 }, viewport]) }
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/sitters/detail/index.js'), 'utf8'), {
    require: () => ({ navMethods: () => ({}) }), Page(config) { page = config }, wx: { createSelectorQuery: () => query }
  })
  page.setData = (update) => Object.assign(page.data, update)
  page.data.sitter = { profileBackgroundFileId: 'cloud://photo' }
  page.measureHeroLayout()
  assert.match(page.data.heroLayoutStyle, /--hero-collapsed-height: 450px/)
  assert.match(page.data.heroLayoutStyle, /--hero-expanded-height: 736px/)
  viewport = { width: 750, height: 400 }
  page.onResize()
  assert.match(page.data.heroLayoutStyle, /--hero-collapsed-height: 520px/)
  assert.match(page.data.heroLayoutStyle, /--hero-expanded-height: 520px/)
})
