const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')

function fixture(respond) {
  let definition
  const calls = [], events = [], toasts = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/components/user-titles/index.js'), 'utf8'), {
    Component(value) { definition = value },
    require() { return { callFunction: async (module, action, data) => { calls.push({ module, action, data }); return respond(action, data) }, showError: error => { throw error } } },
    wx: { showToast: options => toasts.push(options) }
  })
  const component = { ...definition.methods, data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch) }, triggerEvent(name, detail) { events.push({ name, detail }) } }
  return { component, calls, events, toasts }
}

test('title selector loads owned titles, explicitly equips and removes, then publishes the confirmed display', async () => {
  const owned = { id: 'title-1', name: '小区初创者', communityName: '阳光小区' }
  const f = fixture((action, data) => action === 'listUserTitles' ? { list: [owned], equippedTitle: null }
    : { list: [{ ...owned, equipped: !!data.titleId }], equippedTitle: data.titleId ? owned : null,
      publicTitle: data.titleId ? { id: owned.id, name: owned.name, color: '#98661d' } : null, sceneId: 'scene-a' })
  await f.component.open()
  assert.equal(f.calls.length, 1)
  assert.equal(f.component.data.equippedTitle, null)
  await f.component.equip({ currentTarget: { dataset: { id: 'title-1' } } })
  assert.equal(f.calls[1].action, 'equipUserTitle')
  assert.equal(f.calls[1].data.titleId, 'title-1')
  assert.equal(f.events.at(-1).detail.publicTitle.name, owned.name)
  assert.equal(f.events.at(-1).detail.sceneId, 'scene-a')
  await f.component.equip({ currentTarget: { dataset: { id: '' } } })
  assert.equal(f.component.data.equippedTitle, null)
  assert.equal(f.events.at(-1).detail.publicTitle, null)
})

test('a lost equipment response re-reads confirmed state instead of leaving a stale selection', async () => {
  const owned = { id: 'title-1', name: '小区初创者' }
  let equipped = false
  const f = fixture((action) => {
    if (action === 'equipUserTitle') { equipped = true; throw new Error('网络中断') }
    return { list: [{ ...owned, equipped }], equippedTitle: equipped ? owned : null,
      publicTitle: equipped ? owned : null, sceneId: 'scene-a' }
  })
  await f.component.open()
  await f.component.equip({ currentTarget: { dataset: { id: owned.id } } })
  assert.equal(f.component.data.equippedTitle.id, owned.id)
  assert.equal(f.component.data.busy, false)
  assert.equal(f.component.data.updateError, '')
  assert.equal(f.events.at(-1).detail.sceneId, 'scene-a')
  assert.equal(f.toasts.at(-1).title, '佩戴状态已同步')
})

test('failed equipment keeps confirmed inventory and an actionable inline error', async () => {
  const owned = { id: 'title-1', name: '小区初创者' }
  const f = fixture(action => {
    if (action === 'equipUserTitle') throw new Error('更新失败，请稍后重试')
    return { list: [owned], equippedTitle: null, sceneId: 'scene-a', publicTitle: null }
  })
  await f.component.open()
  await f.component.equip({ currentTarget: { dataset: { id: owned.id } } })
  assert.equal(f.component.data.equippedTitle, null)
  assert.equal(f.component.data.busy, false)
  assert.match(f.component.data.updateError, /更新失败/)
  assert.equal(f.toasts.length, 0)
})

test('a delayed title change cannot overwrite the current world after switching communities', () => {
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page(value) { page = value }, require() { return {} }
  })
  const changes = []
  const current = { world: { scene: { sceneId: 'scene-b' }, setOwnName: value => changes.push(value) } }
  page.userTitleChanged.call(current, { detail: { sceneId: 'scene-a', publicTitle: { name: '小区初创者' } } })
  assert.equal(changes.length, 0)
  page.userTitleChanged.call(current, { detail: { sceneId: 'scene-b', publicTitle: null } })
  assert.equal(changes.length, 1)
  assert.equal(changes[0].userTitle, null)
})

test('same-community title replies respect both the current session and the latest live version', () => {
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page(value) { page = value }, require() { return {} }
  })
  const changes = []
  const current = { world: { scene: { sceneId: 'scene-a', session: 'new-session', playerId: 'me' },
    sceneSync: { records: new Map([['me', { version: { epoch: 20, seq: 3 } }]]) },
    setOwnName: value => changes.push(value) } }
  page.userTitleChanged.call(current, { detail: { sceneId: 'scene-a', session: 'old-session', version: { epoch: 10, seq: 8 }, publicTitle: { name: '旧头衔' } } })
  page.userTitleChanged.call(current, { detail: { sceneId: 'scene-a', session: 'new-session', version: { epoch: 20, seq: 2 }, publicTitle: { name: '旧头衔' } } })
  assert.equal(changes.length, 0)
  page.userTitleChanged.call(current, { detail: { sceneId: 'scene-a', session: 'new-session', version: { epoch: 21, seq: 0 }, publicTitle: null } })
  assert.equal(changes.length, 1)
  assert.equal(changes[0].userTitle, null)
  assert.equal(changes[0].version.epoch, 21)
})

test('an older live snapshot cannot restore a title after its confirmed removal', () => {
  const world = Object.create(World2D.prototype)
  world.scene = { userTitle: { name: '初创者' } }
  world.setOwnName({ userTitle: null, version: { epoch: 20, seq: 0 } })
  world.setOwnName({ userTitle: { name: '初创者' }, version: { epoch: 19, seq: 99 } })
  assert.equal(world.scene.userTitle, null)
  assert.equal(world.scene.userTitleVersion.epoch, 20)
  world.setOwnName({ userTitle: { name: '新头衔' }, version: { epoch: 20, seq: 1 } })
  assert.equal(world.scene.userTitle.name, '新头衔')
})

test('title load errors remain retryable without inventing an empty inventory', async () => {
  const f = fixture(() => { throw new Error('读取失败') })
  await f.component.open()
  assert.equal(f.component.data.error, '读取失败')
  assert.equal(f.component.data.loading, false)
  f.component.close()
  assert.equal(f.component.data.visible, false)
})

test('world draws a separate title line and supports clearing the current player title from live records', () => {
  const text = [], world = Object.create(World2D.prototype)
  world.ctx = { save() {}, restore() {}, strokeText(value, x, y) { text.push({ value, x, y }) }, fillText() {} }
  world.scene = { name: '住户', userTitle: null }
  world.setOwnName({ userTitle: { name: '小区初创者', color: '#98661d' } })
  world.drawUserTitle(world.scene.userTitle, 80, 60)
  assert.equal(text[0].value, '【小区初创者】')
  assert.equal(text[0].y, 60)
  world.setOwnName({ userTitle: null })
  assert.equal(world.scene.userTitle, null)
  assert.equal(world.scene.name, '住户')
})
