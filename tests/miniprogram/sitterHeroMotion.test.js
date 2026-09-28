const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const motion = require('../../miniprogram/pages/client/sitters/utils/heroMotion')
const cardStyle = require('../../miniprogram/pages/client/sitters/utils/profileCardStyle')

function loadHero() {
  let page
  let timerId = 0
  const timers = new Map()
  const dimensions = { width: 375, height: 800, normalHeight: 230, compactHeight: 145 }
  const query = {
    in() { return this }, select() { return this }, boundingClientRect() { return this }, selectViewport() { return this }, fields() { return this },
    exec(callback) { callback([{ height: dimensions.normalHeight }, { height: dimensions.compactHeight }, dimensions]) }
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/sitters/detail/index.js'), 'utf8'), {
    require: (name) => name.endsWith('/heroMotion') ? motion : name.endsWith('/profileCardStyle') ? cardStyle : { navMethods: () => ({}) },
    Page(config) { page = config }, wx: { createSelectorQuery: () => query, previewImage() { assert.fail('must remain inline') } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId }, clearTimeout(id) { timers.delete(id) }
  })
  page.setData = (data, callback) => { Object.assign(page.data, data); if (callback) callback() }
  page.data.sitter = { profileBackgroundFileId: 'cloud://photo' }
  page.measureHeroLayout()
  return { page, timers, dimensions, finish() { const callback = [...timers.values()][0]; assert.ok(callback); callback() } }
}

test('expanded card is wider and shorter at narrow/wide widths and large text sizes', () => {
  for (const [w, h, normal, compact] of [[320, 568, 220, 140], [390, 844, 260, 180], [750, 400, 410, 300], [375, 800, 540, 480]]) {
    const layout = motion.buildHeroMotion(w, h, normal, compact)
    assert.ok(layout.ew > layout.cw)
    assert.ok(layout.eh < layout.ch)
    assert.ok(layout.eh >= compact, 'expanded text must fit without clipping')
    assert.ok(layout.collapsed >= layout.ch)
    assert.ok(layout.expanded > layout.collapsed)
  }
})

test('motion keeps document height stable until completion, with equivalent content position at commit', () => {
  const { page, finish } = loadHero()
  const layout = page._heroLayout
  page.toggleHeroExpand()
  assert.equal(page.data.heroExpanded, true)
  assert.equal(page.data.heroCommittedExpanded, false)
  assert.ok(page.data.heroBodyStyle.includes(`${layout.expanded - layout.collapsed}px`))
  finish()
  assert.equal(page.data.heroCommittedExpanded, true)
  assert.equal(page.data.heroMoving, false)
  assert.ok(page.data.heroBodyStyle.includes('transition: none'))
  page.toggleHeroExpand()
  assert.equal(page.data.heroCommittedExpanded, true)
  assert.ok(page.data.heroBodyStyle.includes(`${layout.collapsed - layout.expanded}px`))
  finish()
  assert.equal(page.data.heroCommittedExpanded, false)
})

test('rapid reversals cancel old completion timers and preserve customized styling', () => {
  const { page, timers, finish } = loadHero()
  const style = cardStyle.buildCardStyle({ profileCardOpacity: 20, profileCardBlur: 30 })
  page.data.profileCardStyle = style
  page.toggleHeroExpand()
  page.toggleHeroExpand()
  page.toggleHeroExpand()
  assert.equal(timers.size, 1)
  assert.equal(page.data.heroExpanded, true)
  finish()
  assert.equal(page.data.heroCommittedExpanded, true)
  assert.equal(page.data.profileCardStyle, style)
  page.toggleHeroExpand()
  page.onHide()
  assert.equal(timers.size, 0)
  assert.equal(page.data.heroCommittedExpanded, false)
  page.onUnload()
  assert.equal(timers.size, 0)
})

test('late view-update callbacks cannot commit an obsolete tap', () => {
  const { page, timers, finish } = loadHero()
  const callbacks = []
  page.setData = (data, callback) => { Object.assign(page.data, data); if (callback) callbacks.push(callback) }
  page.toggleHeroExpand()
  page.toggleHeroExpand()
  assert.equal(timers.size, 0, 'wait for the view to apply before starting the completion clock')
  callbacks[1]()
  callbacks[0]()
  assert.equal(timers.size, 1)
  finish()
  assert.equal(page.data.heroCommittedExpanded, false)
})

test('resize remeasures both text layouts and all animation transitions use compositing properties', () => {
  const { page, dimensions } = loadHero()
  dimensions.width = 320
  dimensions.height = 568
  page.onResize()
  assert.equal(page._heroLayout.ew, (320 - 68 * 320 / 750) * 0.94)
  const css = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/sitters/detail/index.wxss'), 'utf8')
  for (const [, declaration] of css.matchAll(/transition:\s*([^;]+);/g)) {
    assert.doesNotMatch(declaration, /\b(height|width|top|left|padding|font-size|filter|all)\b/)
  }
  assert.doesNotMatch(css, /backdrop-filter/)
})
