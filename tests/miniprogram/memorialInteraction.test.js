const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const { MapGestures } = require('../../miniprogram/packageMemorial/scene/gestures')
const { GardenSound } = require('../../miniprogram/packageMemorial/scene/sound')
function scene() {
  return new MemorialScene({ getContext: () => ({}), cancelAnimationFrame() {} }, { width: 390, height: 740 })
}
function close(a, b) { assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`) }
function sounds() {
  const nodes = [], errors = []
  const audio = new GardenSound(() => {
    const node = { plays: 0, pauses: 0, seeks: [], onError(fn) { this.fail = fn },
      play() { this.plays++ }, pause() { this.pauses++ }, seek(t) { this.seeks.push(t) }, destroy() { this.destroyed = true } }
    nodes.push(node)
    return node
  }, error => errors.push(error))
  return { audio, nodes, errors }
}

test('drag keeps the player still, preserves manual framing over time and follow recenters', () => {
  const s = scene(), position = { ...s.player }, before = { ...s.camera }
  s.pan(60, 0)
  close(s.camera.x, before.x - 60 / s.scale)
  assert.equal(s.following, false)
  const camera = { ...s.camera }
  for (let i = 0; i < 60; i++) s.step(.016)
  assert.deepEqual(s.player, position)
  assert.deepEqual(s.camera, camera)
  s.followPlayer()
  assert.equal(s.following, true)
  close(s.camera.x, before.x)
})

test('pinch keeps the touched map point anchored while translating the midpoint', () => {
  const s = scene()
  s.zoomAt(1.1)
  const gestures = new MapGestures(s)
  const initial = [{ id: 1, x: 110, y: 340 }, { id: 2, x: 230, y: 400 }]
  const center = { x: 170, y: 370 }, anchor = s.screenToMap(center), scale = s.scale
  gestures.update(initial)
  gestures.update([{ id: 1, x: 110, y: 315 }, { id: 2, x: 290, y: 405 }])
  close(s.scale, scale * 1.5)
  const after = s.screenToMap({ x: 200, y: 360 })
  close(after.x, anchor.x); close(after.y, anchor.y)
})

test('finger transitions, reordered touch arrays and cancel do not jump the view', () => {
  const s = scene(), g = new MapGestures(s)
  g.update([{ id: 4, x: 150, y: 300 }])
  const start = { ...s.camera }
  g.update([{ id: 8, x: 280, y: 400 }, { id: 4, x: 150, y: 300 }])
  assert.deepEqual(s.camera, start)
  const scale = s.scale
  g.update([{ id: 4, x: 150, y: 300 }, { id: 8, x: 280, y: 400 }])
  close(s.scale, scale)
  g.update([{ id: 8, x: 280, y: 400 }])
  assert.deepEqual(s.camera, start)
  g.reset(); g.update([{ id: 8, x: 10, y: 20 }])
  assert.deepEqual(s.camera, start)
})

test('zoom can fit the whole garden and preserves manual scale across landscape resize', () => {
  const s = scene()
  s.zoomAt(.00001)
  close(s.scale, s.minZoom)
  const minimum = s.scale
  assert.ok(s.scale * 3072 <= s.width)
  assert.ok(s.scale * 2304 <= s.height)
  s.resize(844, 330, 3)
  close(s.scale, minimum)
  assert.equal(s.dpr, 2)
  s.zoomAt(1e10); close(s.zoom, 1.8)
  s.pan(-1e9, -1e9)
  close(s.camera.x, 3072 - s.width / s.scale / 2)
  close(s.camera.y, 2304 - s.height / s.scale / 2)
  const scale = s.scale
  s.zoomAt(NaN); s.zoomAt(-1)
  assert.equal(s.scale, scale)
})

test('music/effects are separate opt-ins; footsteps advance only with actual travel', () => {
  const { audio, nodes } = sounds()
  audio.travel(300); audio.chime()
  assert.equal(nodes.length, 0)
  assert.equal(audio.toggle('music'), true)
  assert.equal(nodes[0].loop, true)
  assert.equal(nodes[0].plays, 1)
  audio.toggle('effects')
  assert.equal(nodes[1].src.endsWith('chime.wav'), true)
  audio.travel(48)
  assert.equal(nodes.length, 2)
  audio.travel(1)
  assert.equal(nodes[2].src.endsWith('step.wav'), true)
  assert.equal(nodes[2].plays, 1)
  audio.travel(0)
  assert.equal(nodes[2].plays, 1)
  audio.toggle('effects')
  audio.travel(100)
  assert.equal(nodes[2].plays, 1)
  assert.equal(audio.music, true)
})

test('background, audio interruption and destruction stop all sounds without duplicate resume', () => {
  const { audio, nodes } = sounds()
  audio.toggle('music'); audio.toggle('effects'); audio.travel(49)
  audio.pause()
  nodes.forEach(n => assert.equal(n.pauses, 1))
  audio.travel(99); audio.chime()
  assert.equal(nodes[2].plays, 1)
  audio.resume(); audio.resume()
  assert.equal(nodes[0].plays, 2)
  audio.destroy(); audio.resume(); audio.toggle('music')
  nodes.forEach(n => assert.equal(n.destroyed, true))
  assert.equal(nodes[0].plays, 2)
})

test('failed audio is released for retry; stale play rejection after pause is ignored', async () => {
  const { audio, nodes, errors } = sounds()
  audio.toggle('music')
  nodes[0].fail()
  assert.equal(audio.music, false)
  assert.equal(nodes[0].destroyed, true)
  assert.deepEqual(errors, ['music'])
  audio.toggle('music')
  assert.equal(nodes.length, 2)
  let reject
  nodes[1].play = () => new Promise((_, no) => { reject = no })
  audio.pause(); audio.resume(); audio.pause()
  reject(new Error('play interrupted by pause'))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(audio.music, true)
  assert.equal(errors.length, 1)
})

function pageFixture(saved = {}) {
  let definition, resized = 0
  const audio = sounds(), events = {}
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/garden'), 'utf8'), {
    Page: value => { definition = value },
    require: name => name === '../scene/cloud-assets' ? { createCloudAssets: () => {
      const resolve = key => '/packageMemorial/assets/' + key
      resolve.dispose = () => {}
      return resolve
    } } : require('../../miniprogram/packageMemorial/scene/' + name.split('/').pop()),
    wx: { getStorageSync(key) { return saved[key] }, setStorageSync(key, value) { saved[key] = value }, createInnerAudioContext: audio.audio.createAudio,
      onAudioInterruptionBegin: fn => { events.begin = fn }, onAudioInterruptionEnd: fn => { events.end = fn },
      showToast() {},
      offAudioInterruptionBegin: fn => { assert.equal(fn, events.begin); delete events.begin },
      offAudioInterruptionEnd: fn => { assert.equal(fn, events.end); delete events.end } }
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } }
  page.onLoad(); page._visible = true; page._ready = true
  page.scene = scene(); page.scene.ready = true; page.scene.draw = () => {}
  page.gestures = new MapGestures(page.scene)
  page._canvasRect = { left: 20, top: 80 }
  page._pad = { left: 22, top: 560, width: 118, height: 118 }
  page.measure = () => { resized++ }
  return { page, events, nodes: audio.nodes, resizes: () => resized }
}

test('native map touch coordinates exclude navigation offset and other controls', () => {
  const { page } = pageFixture()
  const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY })
  const a = touch(1, 180, 400), b = touch(1, 200, 400)
  page.mapTouchStart({ changedTouches: [a], touches: [a] })
  const before = page.scene.camera.x
  page.mapTouchMove({ touches: [b, touch(99, 900, 900)] })
  close(page.scene.camera.x, before - 20 / page.scene.scale)
  const camera = page.scene.camera.x
  page.joystickStart({ changedTouches: [touch(2, 100, 619)], touches: [b, touch(2, 100, 619)] })
  assert.equal(page.scene.following, true)
  assert.notEqual(page.scene.camera.x, camera)
  page.mapTouchMove({ touches: [touch(1, 300, 400)] })
  assert.equal(page.gestures.previous, null)
  page.onResize()
  assert.equal(page._touchId, undefined)
  assert.equal(page.gestures.previous, null)
  assert.deepEqual(page.scene.input, { x: 0, y: 0 })
  page.onUnload()
})

test('native audio interruption does not resume on a hidden page and unregisters on exit', () => {
  const { page, events, nodes } = pageFixture()
  page.sound.resume()
  assert.equal(page.data.music, true)
  assert.equal(page.data.effects, true)
  assert.equal(nodes[0].plays, 1)
  events.begin()
  page.onHide(); events.end()
  assert.equal(nodes[0].plays, 1)
  page.scene.start = () => {}
  page.onShow()
  assert.equal(nodes[0].plays, 2)
  page.onUnload()
  assert.equal(nodes[0].destroyed, true)
  assert.deepEqual(events, {})
})

test('native Canvas2D local x/y touches pan and pinch without producing NaN', () => {
  const { page } = pageFixture()
  const a = { identifier: 3, x: 110, y: 300 }
  page.mapTouchStart({ changedTouches: [a], touches: [a] })
  const before = page.scene.camera.x
  page.mapTouchMove({ touches: [{ identifier: 3, x: 130, y: 300 }] })
  close(page.scene.camera.x, before - 20 / page.scene.scale)
  const b = { identifier: 6, x: 230, y: 300 }, scale = page.scene.scale
  page.mapTouchStart({ changedTouches: [b], touches: [{ identifier: 3, x: 130, y: 300 }, b] })
  page.mapTouchMove({ touches: [{ identifier: 3, x: 100, y: 300 }, { identifier: 6, x: 260, y: 300 }] })
  close(page.scene.scale, scale * 1.6)
  page.onUnload()
})

test('native page enables device orientation and local PCM assets are nonempty without clipping', () => {
  assert.equal(require('../../miniprogram/packageMemorial/pages/garden.json').pageOrientation, 'auto')
  for (const name of ['music', 'step', 'chime']) {
    const data = fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/assets/audio/' + name + '.wav'))
    assert.equal(data.toString('ascii', 0, 4), 'RIFF')
    assert.equal(data.readUInt32LE(24), 22050)
    assert.equal(data.readUInt16LE(34), 16)
    let maximum = 0, energy = 0
    for (let i = 44; i < data.length; i += 2) {
      const sample = data.readInt16LE(i)
      maximum = Math.max(maximum, Math.abs(sample)); energy += sample * sample
    }
    assert.ok(maximum < 32767 && maximum > 1000)
    assert.ok(energy > 0)
    if (name === 'music') assert.equal((data.length - 44) / 2 / 22050, 20)
  }
})


test('native first visit enables both sounds and saved false values survive later visits and playback errors', () => {
  const saved = {}, first = pageFixture(saved)
  assert.equal(first.page.data.music, true); assert.equal(first.page.data.effects, true)
  first.page.toggleSound({ currentTarget: { dataset: { setting: 'effects' } } })
  assert.equal(saved['memorial-sound-v1'].effects, false)
  first.page.onUnload()
  const next = pageFixture(saved)
  assert.equal(next.page.data.effects, false); assert.equal(next.page.data.music, true)
  next.page.sound.resume(); next.nodes[0].fail()
  assert.equal(next.page.data.music, true)
  assert.equal(saved['memorial-sound-v1'].music, true)
  assert.match(next.page.data.audioError, /重试/)
  next.page.onUnload()
})

test('native map selects a valid unoccupied plot, submits it and refreshes application status', async () => {
  const { page } = pageFixture(), world = require('../../miniprogram/packageMemorial/scene/world-index')
  const calls = []
  page._worldData = { occupied: [], memorials: [] }
  page.scene.screenToMap = point => point
  page.data.selectingPlot = true
  page.selectMapPoint(world.cells[0])
  assert.equal(page.data.selection.plotId, world.cells[0].id)
  page.openApplication()
  Object.assign(page.data.form, { petName: '小白', epitaph: '想念你', date: '2025-01-01' })
  page.api = async (action, data) => {
    calls.push({ action, data })
    if (action === 'world') return { occupied: [world.cells[0].id], memorials: [] }
    if (action === 'listMine') return { list: [{ _id: 'application', status: 'pending', petName: '小白' }], cursor: '', hasMore: false }
    return { id: 'application', status: 'pending' }
  }
  await page.submitApplication()
  assert.equal(calls[0].action, 'submit')
  assert.equal(calls[0].data.plotId, world.cells[0].id)
  assert.equal(page.data.applications[0].statusText, '待审核')
  assert.equal(page.data.form, null)
  page.onUnload()
})
