const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const { MapGestures } = require('../../miniprogram/packageMemorial/scene/gestures')
const { WIDTH, HEIGHT } = require('../../miniprogram/packageMemorial/scene/world-template')
const { GardenSound } = require('../../miniprogram/packageMemorial/scene/sound')
function scene() {
  return new MemorialScene({ getContext: () => ({}), cancelAnimationFrame() {} }, { width: 390, height: 740 })
}
function close(a, b) { assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`) }
function sounds() {
  const nodes = [], errors = []
  const audio = new GardenSound(() => {
    const node = { plays: 0, pauses: 0, seeks: [], onError(fn) { this.fail = fn }, onPlay(fn) { this.played = fn },
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
  assert.ok(s.scale * WIDTH <= s.width)
  assert.ok(s.scale * HEIGHT <= s.height)
  s.resize(844, 330, 3)
  close(s.scale, Math.max(minimum, s.minZoom))
  s.zoomAt(10); const manual = s.scale
  s.resize(390, 740, 2); close(s.scale, manual)
  assert.equal(s.dpr, 2)
  s.zoomAt(1e10); close(s.zoom, 1.8)
  s.pan(-1e9, -1e9)
  close(s.camera.x, WIDTH - s.width / s.scale / 2)
  close(s.camera.y, HEIGHT - s.height / s.scale / 2)
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

function pageFixture(saved = {}, windowInfo = {}) {
  let definition, resized = 0
  const audio = sounds(), events = {}
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/garden'), 'utf8'), {
    setTimeout, clearTimeout, Page: value => { definition = value },
    require: name => name === '../scene/cloud-assets' ? { createCloudAssets: () => {
      const resolve = key => '/packageMemorial/assets/' + key
      resolve.dispose = () => {}
      return resolve
    } } : require('node:module').createRequire(require.resolve('../../miniprogram/packageMemorial/pages/garden'))(name),
    wx: { getWindowInfo: () => windowInfo, getMenuButtonBoundingClientRect: () => ({ bottom: windowInfo.menuBottom || 0 }), getStorageSync(key) { return saved[key] }, setStorageSync(key, value) { saved[key] = value }, createInnerAudioContext: audio.audio.createAudio,
      onAudioInterruptionBegin: fn => { events.begin = fn }, onAudioInterruptionEnd: fn => { events.end = fn },
      showToast() {},
      offAudioInterruptionBegin: fn => { assert.equal(fn, events.begin); delete events.begin },
      offAudioInterruptionEnd: fn => { assert.equal(fn, events.end); delete events.end } }
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } }
  page.onLoad(); page._visible = true; page._ready = true
  page.data.loading = false; page.scene = scene(); page.scene.ready = true; page.scene.draw = () => {}
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
  page.unlockAudio()
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
  const plot = world.cells.find(p => require('../../miniprogram/packageMemorial/scene/plot-layout').ids.includes(p.id))
  page.selectMapPoint(plot)
  assert.equal(page.data.selection.plotId, plot.id)
  page.openApplication()
  Object.assign(page.data.form, { petName: '小白', epitaph: '想念你', date: '2025-01-01' })
  page.api = async (action, data) => {
    calls.push({ action, data })
    if (action === 'world') return { occupied: [plot.id], memorials: [] }
    if (action === 'listMine') return { list: [{ _id: 'application', status: 'pending', petName: '小白' }], cursor: '', hasMore: false }
    return { id: 'application', status: 'pending' }
  }
  await page.submitApplication()
  assert.equal(calls[0].action, 'submit')
  assert.equal(calls[0].data.plotId, plot.id)
  assert.equal(page.data.applications[0].statusText, '待审核')
  assert.equal(page.data.form, null)
  page.onUnload()
})

test('both map entrances return to walking, including selected plots and late world responses', async () => {
  const { page } = pageFixture()
  page.scene.onViewChange = view => page.setData(view)
  const before = { ...page.scene.player }
  page.toggleOverview()
  assert.equal(page.data.overview, true)
  page.returnToWalk()
  assert.equal(page.scene.overview, false)
  assert.equal(page.data.overview, false)
  let resolveWorld
  page.api = () => new Promise(resolve => { resolveWorld = resolve })
  const entering = page.choosePlot()
  assert.equal(page.data.selectingPlot, true)
  assert.equal(page.scene.showGrid, true)
  assert.ok(page.scene.scale >= .7, 'numbers must be readable on entry')
  page.data.selection = { plotId: 'selected' }
  page.scene.selectedPoint = page.data.selection
  page.returnToWalk()
  resolveWorld({ occupied: [], memorials: [] })
  await entering
  for (const key of ['overview', 'selectingPlot', 'grid']) assert.equal(page.data[key], false)
  assert.equal(page.scene.showGrid, false)
  assert.equal(page.scene.selectedPoint, null)
  assert.equal(page.data.selection, null)
  assert.equal(page.scene.following, true)
  assert.deepEqual(page.scene.player, before)
  assert.equal(page._mapTap, null)
  assert.equal(page.gestures.previous, null)
  page.toggleOverview(); page.toggleOverview()
  assert.equal(page.scene.overview, false)
  page.onUnload()
})

test('plot selection cannot snap from an occupied plot, a road or a loading/error state to an adjacent free plot', () => {
  const { page } = pageFixture(), world = require('../../miniprogram/packageMemorial/scene/world-index')
  const plot = world.cells.find(p => require('../../miniprogram/packageMemorial/scene/plot-layout').ids.includes(p.id))
  page.scene.screenToMap = p => p
  page.data.selectingPlot = true
  page._worldData = { occupied: [plot.id], memorials: [] }
  page.selectMapPoint(plot)
  assert.equal(page.data.selection, null)
  page._worldData.occupied = []
  page.selectMapPoint({ x: 768, y: 576 })
  assert.equal(page.data.selection, null)
  page.data.worldLoading = true
  page.selectMapPoint(plot)
  assert.equal(page.data.selection, null)
  page.data.worldLoading = false
  page.data.applicationError = 'offline'
  page.selectMapPoint(plot)
  assert.equal(page.data.selection, null)
  page.data.applicationError = ''
  page.selectMapPoint(plot)
  assert.equal(page.data.selection.plotId, plot.id)
  const number = page.data.selection.plotNumber
  assert.match(number, /^\d{2}-\d{2}$/)
  page.openApplication()
  assert.equal(page.data.form.plotNumber, number)
  page.onUnload()
})

test('selection map supports pan/pinch without leaving selection mode or selecting on a drag', async () => {
  const { page } = pageFixture()
  page.scene.onViewChange = view => page.setData(view)
  page.api = async () => ({ occupied: [], memorials: [] })
  await page.choosePlot()
  const touch = (id, x, y) => ({ identifier: id, x, y })
  const a = touch(1, 150, 300), b = touch(1, 180, 300)
  const x = page.scene.camera.x
  page.mapTouchStart({ changedTouches: [a], touches: [a] })
  page.mapTouchMove({ touches: [b] })
  page.mapTouchEnd({ changedTouches: [b], touches: [] })
  assert.notEqual(page.scene.camera.x, x)
  assert.equal(page.data.selection, null)
  page.zoom({ currentTarget: { dataset: { delta: .3 } } })
  assert.equal(page.scene.overview, true)
  assert.equal(page.data.selectingPlot, true)
  page.showWholeMap()
  assert.equal(page.scene.scale, page.scene.minZoom)
  page.selectMapPoint({ x: 180, y: 300 })
  assert.ok(page.scene.scale >= .7)
  page.returnToWalk()
  assert.equal(page.scene.overview, false)
  assert.equal(page.scene.scale, page.scene.zoom)
  page.onUnload()
})

test('native errors after pause cannot disable audio and explicit retry plays a chime', () => {
  const { audio, nodes, errors } = sounds()
  audio.toggle('effects'); audio.pause(); nodes[0].fail({ errMsg: 'interrupted' })
  assert.equal(audio.effects, true); assert.deepEqual(errors, [])
  const { page, nodes: pageNodes } = pageFixture()
  page.sound.resume(); page.retryAudio()
  assert.ok(pageNodes.some(n => n.src.endsWith('chime.wav') && n.plays > 0))
  page.dismissAudio(); assert.equal(page.data.audioDismissed, true)
  page.onUnload()
})
test('visit opens the matching card and positions the map; walking taps hit the visible memorial', () => {
  const { page } = pageFixture(), world = require('../../miniprogram/packageMemorial/scene/world-index')
  const p = world.cells[0]
  page.data.applications = [{ _id: 'approved-app', plotId: p.id, petName: '小白', date: '2025-01-01' }]
  page.visitMemorial({ currentTarget: { dataset: { id: 'approved-app', plot: p.id } } })
  assert.equal(page.data.applications, null)
  assert.equal(page.data.memorialCard.applicationId, 'approved-app')
  assert.equal(page.scene.overview, true)
  assert.deepEqual(page.scene.selectedPoint, p)
  page.closeMemorial(); page.returnToWalk()
  page._worldData = { occupied: [], memorials: [{ ...p, applicationId: 'approved-app' }] }
  page.scene.screenToMap = p => p
  assert.equal(page.selectMemorial({ x: p.x, y: p.y - 80 }), true)
  assert.equal(page.data.memorialCard.applicationId, 'approved-app')
  page.closeMemorial()
  const t = { identifier: 1, x: p.x, y: p.y }
  page.mapTouchStart({ changedTouches: [t], touches: [t] })
  page.mapTouchMove({ touches: [{ ...t, x: p.x + 30 }] })
  page.mapTouchEnd({ changedTouches: [t], touches: [] })
  assert.equal(page.data.memorialCard, null, 'dragging must not open a memorial')
  page.onUnload()
})

test('HUD insets clear portrait camera cutouts and either landscape cutout edge', () => {
  const portrait = pageFixture({}, { windowWidth: 390, statusBarHeight: 54, menuBottom: 88, safeArea: { top: 54, left: 0, right: 390 } })
  assert.equal(portrait.page.data.hudTop, 96)
  portrait.page.onUnload()
  for (const safeArea of [{ top: 0, left: 44, right: 844 }, { top: 0, left: 0, right: 800 }]) {
    const f = pageFixture({}, { windowWidth: 844, safeArea })
    assert.ok(f.page.data.hudLeft >= safeArea.left + 8)
    assert.ok(f.page.data.hudRight >= 844 - safeArea.right + 8)
    f.page.onUnload()
  }
})

test('turning off unrelated audio does not hide a failure; retry tests the failed footstep asset', () => {
  const { page, nodes } = pageFixture()
  page.sound.resume(); page.sound.travel(49)
  const step = nodes.find(n => n.src.endsWith('step.wav'))
  step.fail({ errMsg: 'footstep decode failed' })
  page.toggleSound({ currentTarget: { dataset: { setting: 'music' } } })
  assert.match(page.data.audioError, /音效/)
  assert.equal(page.data.audioDetail, 'footstep decode failed')
  page.retryAudio()
  const replay = nodes.at(-1)
  assert.ok(replay.src.endsWith('step.wav'))
  assert.ok(replay.plays > 0)
  page.sound.chime(); nodes.at(-1).played()
  assert.match(page.data.audioError, /音效/, 'chime success cannot clear an outstanding footstep error')
  replay.played()
  assert.equal(page.data.audioError, '')
  assert.equal(page.data.audioDetail, '')
  page.onUnload()
})

test('entering with music enabled waits for the first interaction and interruption end cannot bypass it', async () => {
  const { page, nodes, events } = pageFixture()
  page.startPresence = () => {}
  page.scene.start = () => {}
  page.onShow()
  await Promise.resolve()
  assert.equal(nodes.length, 0)
  assert.equal(page.data.audioError, '')
  events.begin(); events.end()
  assert.equal(nodes.length, 0)
  page.toggleSettings()
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].plays, 1)
  page.unlockAudio(); page.toggleSettings()
  assert.equal(nodes[0].plays, 1)
  page.onHide(); page.onShow()
  assert.equal(nodes[0].plays, 2)
  page.onUnload()
})

test('retrying after pause starts music once and disabled music never autostarts', () => {
  const { page, nodes } = pageFixture()
  page.retryAudio()
  assert.equal(nodes.find(n => n.src.endsWith('music.wav')).plays, 1)
  page.onUnload()
  const muted = pageFixture({ 'memorial-sound-v1': { music: false, effects: false } })
  muted.page.toggleSettings(); muted.page.retryAudio()
  assert.equal(muted.nodes.length, 0)
  muted.page.onUnload()
})

test('native audio waits for canplay, deduplicates pending starts and ignores repeated readiness', () => {
  const nodes = [], errors = []
  const sound = new GardenSound(() => {
    const node = { plays: 0, onCanplay(fn) { this.ready = fn }, onError(fn) { this.fail = fn }, onPlay(fn) { this.played = fn },
      play() { this.plays++ }, pause() {}, destroy() {}, seek() {} }
    nodes.push(node); return node
  }, (...error) => errors.push(error))
  sound.toggle('music')
  assert.equal(nodes[0].plays, 0)
  sound.play('music'); assert.equal(nodes.length, 1)
  nodes[0].ready(); nodes[0].ready()
  assert.equal(nodes[0].plays, 1)
  assert.equal(nodes[0]._readyTimer, null)
  sound.toggle('effects'); sound.chime()
  const chime = nodes[1]
  assert.equal(chime.plays, 0)
  sound.pause(); chime.ready()
  assert.equal(chime.plays, 0)
  assert.equal(chime._readyTimer, null)
  sound.resume(); assert.equal(nodes[0].plays, 2)
  sound.destroy(); nodes[0].ready(); chime.ready()
  assert.equal(nodes[0].plays, 2); assert.deepEqual(errors, [])
})

test('real decode failure while preparing audio stays visible and retry uses a fresh node', () => {
  const nodes = [], errors = []
  const sound = new GardenSound(() => {
    const node = { plays: 0, onCanplay(fn) { this.ready = fn }, onError(fn) { this.fail = fn },
      play() { this.plays++ }, pause() {}, destroy() { this.destroyed = true } }
    nodes.push(node); return node
  }, (...error) => errors.push(error))
  sound.toggle('music'); nodes[0].fail({ errCode: 10004, errMsg: 'decode error' })
  assert.equal(errors.length, 1); assert.equal(sound.music, false)
  assert.equal(nodes[0]._readyTimer, null); assert.equal(nodes[0].destroyed, true)
  sound.toggle('music'); nodes[0].ready(); assert.equal(nodes[1].plays, 0)
  nodes[1].ready(); assert.equal(nodes[1].plays, 1)
  sound.destroy()
})

test('missing native readiness times out and does not leave the player silently stuck', () => {
  const timers = new Map(), errors = []
  let serial = 0, node
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/scene/sound'), 'utf8'), {
    module, setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial }, clearTimeout(id) { timers.delete(id) }
  })
  const sound = new module.exports.GardenSound(() => (node = { onCanplay(fn) { this.ready = fn }, onError() {}, play() { throw new Error('must wait for ready') }, pause() {}, destroy() {} }), (...args) => errors.push(args))
  sound.toggle('music')
  const pending = [...timers.values()][0]
  assert.equal(pending.ms, 10000)
  pending.fn()
  assert.equal(errors.length, 1)
  assert.match(errors[0][1].message, /准备超时/)
  assert.equal(timers.size, 0)
  node.ready(); assert.equal(errors.length, 1)
  sound.destroy()
})

test('active native sound ignores rapid replay and WeChat already-playing errors without disabling effects', () => {
  let node; const errors=[], invalidated=[]
  const resolve=Object.assign(k=>k,{invalidate:k=>invalidated.push(k)})
  const sound=new GardenSound(()=>node={plays:0,onError(fn){this.fail=fn},onEnded(fn){this.end=fn},play(){this.plays++},pause(){},destroy(){this.destroyed=true},seek(){}},(...e)=>errors.push(e),resolve)
  sound.toggle('effects'); for(let i=0;i<20;i++)sound.chime()
  assert.equal(node.plays,1)
  node.fail({errMsg:'operateAudio:fail:audio is playing, dont play agin'})
  assert.equal(sound.effects,true); assert.equal(errors.length,0); assert.equal(invalidated.length,0)
  node.end(); sound.chime(); assert.equal(node.plays,2)
  node.fail({errMsg:'operateAudio:fail:decode error'})
  assert.equal(sound.effects,false); assert.equal(errors.length,1); assert.equal(invalidated.length,1)
  sound.destroy()
})

test('entrance ignores stale results after changing memorial, closing popup or hiding page', async () => {
  const { page }=pageFixture(); const pending=[]
  page.api=(action,data)=>new Promise(resolve=>pending.push({action,data,resolve}))
  page.data.memorialCard={applicationId:'first'}; const first=page.loadEntrance()
  page.data.memorialCard={applicationId:'second'}; const second=page.loadEntrance()
  pending[1].resolve({images:[{uploadId:'second-image'}],videos:[]}); await second
  pending[0].resolve({images:[{uploadId:'first-image'}],videos:[]}); await first
  assert.equal(page.data.entrance.images[0].uploadId,'second-image')
  const third=page.loadEntrance(); page.closeMemorial(); pending[2].resolve({images:[{}],videos:[]}); await third
  assert.equal(page.data.entrance,null); assert.equal(page.data.memorialCard,null)
  page.data.memorialCard={applicationId:'second'}; const fourth=page.loadEntrance(); page.onHide(); pending[3].resolve({images:[{}],videos:[]}); await fourth
  assert.equal(page.data.entrance,null); assert.equal(page.data.entranceLoading,false)
  page.onUnload()
})
test('cross-garden visit carries garden and plot ids while closing same-garden chooser preserves scene', () => {
  const { page }=pageFixture(); const entered=[]
  page.enterGarden=(...args)=>entered.push(args)
  page.data.applications=[{_id:'other-app',gardenId:'garden_'+'b'.repeat(32),plotId:'garden-ortho-v2:3:3'}]
  page.visitMemorial({currentTarget:{dataset:{id:'other-app'}}})
  assert.deepEqual(entered,[[page.data.applications[0].gardenId,'garden-ortho-v2:3:3']])
  page.onUnload()
})
