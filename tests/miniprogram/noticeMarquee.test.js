const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')
const componentPath = path.join(root, 'components/notice-marquee')

function createMarquee() {
  let options
  const modals = []
  vm.runInNewContext(fs.readFileSync(path.join(componentPath, 'index.js'), 'utf8'), {
    Component(value) { options = value },
    wx: { showModal(value) { modals.push(value) } }
  })
  const component = {
    data: { ...options.data },
    setData(patch) { Object.assign(this.data, patch) },
    ...options.methods
  }
  return { component, update: notice => options.observers.notice.call(component, notice), modals }
}

test('short single notice fills a cycle, loops continuously, and opens full text', () => {
  const { component, update, modals } = createMarquee()
  update({ enabled: true, items: [' 重要通知 '] })
  assert.ok(component.data.cycleItems.length > 1)
  assert.ok(component.data.cycleItems.every(item => item.text === '重要通知'))
  assert.ok(component.data.duration >= 10)
  component.showNotice({ currentTarget: { dataset: { text: '重要通知' } } })
  assert.equal(modals[0].content, '重要通知')
})

test('multiple notices keep their order in each repeated cycle and update cleanly', () => {
  const { component, update } = createMarquee()
  update({ enabled: true, items: ['第一条', '第二条'] })
  assert.deepEqual(Array.from(component.data.cycleItems.slice(0, 2), item => item.text), ['第一条', '第二条'])
  assert.equal(component.data.cycleItems.length % 2, 0)
  update({ enabled: true, items: ['新的公告'] })
  assert.ok(component.data.cycleItems.every(item => item.text === '新的公告'))
  update({ enabled: false, items: ['新的公告'] })
  assert.equal(component.data.cycleItems.length, 0)
})

test('long notices remain complete and use a proportional scrolling duration', () => {
  const { component, update } = createMarquee()
  const longText = '公告内容'.repeat(30)
  update({ enabled: true, items: [longText] })
  assert.equal(component.data.cycleItems[0].text, longText)
  assert.equal(component.data.cycleItems.length, 1)
  assert.ok(component.data.duration > 10)
})

test('only the home page renders the seamless horizontal marquee', () => {
  const home = fs.readFileSync(path.join(root, 'pages/client/home/index.wxml'), 'utf8')
  const booking = fs.readFileSync(path.join(root, 'pages/client/orders/create/index.wxml'), 'utf8')
  const markup = fs.readFileSync(path.join(componentPath, 'index.wxml'), 'utf8')
  const styles = fs.readFileSync(path.join(componentPath, 'index.wxss'), 'utf8')
  assert.match(home, /<notice-marquee[^>]+notice="{{noticeTicker}}"/)
  assert.doesNotMatch(booking, /<notice-marquee/)
  assert.doesNotMatch(booking, /ticker-swiper/)
  assert.match(markup, /wx:for="{{\[0, 1\]}}"/)
  assert.match(markup, /bindtap="showNotice"/)
  assert.match(styles, /animation:\s*notice-scroll\s+12s\s+linear\s+infinite/)
  assert.match(styles, /translateX\(-50%\)/)
  assert.doesNotMatch(styles, /text-overflow:\s*ellipsis/)
})
