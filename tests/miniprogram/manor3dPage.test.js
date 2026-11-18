const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { ENV_MAP, hasManorAssets } = require('../../miniprogram/envList')

const source = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/pages/index.js'), 'utf8')
const markup = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/pages/index.wxml'), 'utf8')
const pageConfig = require('../../miniprogram/packageManor3d/pages/index.json')
const flush = () => new Promise(resolve => setImmediate(resolve))
const layout = JSON.stringify({ world: { width: 1200, depth: 960 }, plots: [{ id: 'M01', x: 0, z: 0, y: 4.1, width: 40, depth: 30 }] })
const choose = character => ({ currentTarget: { dataset: { character } } })
const touchEvent = (points, changed = []) => {
  const touch = ([identifier, x, y]) => ({ identifier, x, y })
  return { touches: points.map(touch), changedTouches: changed.map(touch) }
}

function fixture({ envId = ENV_MAP.trial, read = key => key === 'layout' ? layout : key,
  decode = key => ({ key }), savedCharacter, canGoBack = true } = {}) {
  let definition, nextFrame = 0, now = 0, lost = false, pixelRatio = 1
  let canvasSize = { width: 390, height: 780 }
  const events = [], frames = new Map(), updates = [], inputs = [], sizes = [], drawSizes = [], selections = []
  const canvas = {
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame(id) { frames.delete(id) }
  }
  function createSelectorQuery() {
    let selector
    const query = {
      in: () => query, fields: () => query, boundingClientRect: () => query,
      select(id) { selector = id; return query },
      exec(callback) {
        assert.ok(['#manor-canvas', '#manor-stick'].includes(selector), selector)
        callback([selector === '#manor-stick' ? { left: 15, top: 300, width: 100, height: 100 }
          : { node: canvas, ...canvasSize }])
      }
    }
    return query
  }
  const modules = {
    '../../envList': { getActiveEnvId: () => envId },
    '../utils/cloud-assets': { hasManorAssets, createCloudAssets({ envId: actualId }) {
      assert.equal(actualId, envId)
      return {
        async read(key, options) { events.push('read:' + key); return read(key, options) },
        invalidate(key) { events.push('invalidate:' + key) },
        cancel() { events.push('cancel') }
      }
    } },
    '../utils/model-runtime': {
      THREE: {}, createRenderer(node) {
        assert.equal(node, canvas)
        events.push('createRenderer')
        return { getContext: () => ({ isContextLost: () => lost }), getPixelRatio: () => pixelRatio,
          setPixelRatio(value) { pixelRatio = value }, dispose() { events.push('disposeRenderer') } }
      },
      async loadGlb(key, node, wx, options) { assert.equal(node, canvas); return decode(key, options) },
      disposeModel(group) { events.push('dispose:' + group.key) }
    },
    '../utils/manor-scene': { createManorScene: () => ({
      resize(width, height) { sizes.push({ width, height, pixelRatio }) }, showLandscape(model) { events.push('attach:' + model.key) },
      showVilla(model) { events.push('attach:' + model.key) }, render() { events.push('draw'); drawSizes.push(sizes.at(-1)) },
      showCharacter(model) { events.push('attach:' + model.key) },
      setPlayerInput(x, y, running) { inputs.push({ x, y, running }) },
      dispose() { events.push('disposeScene') }, pan(x, y) { events.push(['pan', x, y]) },
      orbit(x, y) { events.push(['orbit', x, y]) }, zoom(ratio) { events.push(['zoom', ratio]) },
      resetView() { events.push('reset') }, focusVilla() { events.push('focus') },
      focusCharacter() { events.push('focusCharacter') }
    }) }
  }
  vm.runInNewContext(source, {
    require: path => { assert.ok(modules[path], path); return modules[path] },
    Page: value => { definition = value }, Date: { now: () => now },
    setTimeout, clearTimeout, console: { warn() {} },
    wx: {
      createSelectorQuery, getWindowInfo: () => ({ pixelRatio: 3 }),
      getStorageSync: () => savedCharacter,
      setStorageSync(key, value) { selections.push(value) },
      navigateBack({ fail }) { events.push('back'); if (!canGoBack) fail() },
      redirectTo({ url }) { events.push('redirect:' + url) }
    }
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(data, callback) {
    updates.push(data); Object.assign(this.data, data); callback?.()
  } }
  return { page, frames, events, updates, inputs, sizes, drawSizes, selections, loseContext() { lost = true }, restoreContext() { lost = false },
    setCanvasSize(width, height) { canvasSize = { width, height } },
    mount() { page.onLoad(); page.onShow(); page.onReady() },
    tick() { now += 34; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) } }
}

test('the terrain and player are ready before the villa download, and a villa retry preserves them', async () => {
  let rejectVilla, villaAttempts = 0
  const f = fixture({ read(key, options) {
    if (key === 'layout') return layout
    if (key === 'manor') {
      options.onProgress({ progress: 40, totalBytesWritten: 4, totalBytesExpectedToWrite: 10 })
      return key
    }
    if (key === 'villa' && ++villaAttempts === 1) return new Promise((resolve, reject) => { rejectVilla = reject })
    return key
  } })
  f.mount()
  await flush()
  assert.equal(f.page.data.status, 'ready')
  assert.equal(f.page.data.villaStatus, 'loading')
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.ok(f.updates.some(data => data.progress === 40))
  assert.ok(f.events.indexOf('draw') < f.events.indexOf('read:boy'))
  assert.ok(f.events.indexOf('attach:boy') < f.events.indexOf('read:villa'))
  rejectVilla(new Error('connection lost'))
  await flush()
  assert.equal(f.page.data.villaStatus, 'error')
  assert.equal(f.frames.size, 1)
  f.page.retryVilla()
  await flush()
  assert.equal(f.page.data.villaStatus, 'ready')
  assert.equal(f.events.filter(value => value === 'read:manor').length, 1)
  assert.equal(f.events.filter(value => value === 'read:boy').length, 1)
  assert.equal(f.events.filter(value => value === 'createRenderer').length, 1)
  f.page.focusVilla()
  assert.equal(f.events.at(-1), 'focus')
  f.page.onUnload()
  assert.equal(f.frames.size, 0)
  assert.deepEqual(f.events.slice(-2), ['disposeScene', 'disposeRenderer'])
})

test('resuming a terrain load after rotating uses the new canvas size on its first draw', async () => {
  let resolveOld, oldOptions, attempts = 0
  const f = fixture({ decode(key, options) {
    if (key === 'manor' && ++attempts === 1) {
      oldOptions = options
      return new Promise(resolve => { resolveOld = resolve })
    }
    return { key }
  } })
  f.mount()
  await flush()
  f.page.onHide()
  assert.equal(oldOptions.isCancelled(), true)
  assert.equal(f.frames.size, 0)
  f.setCanvasSize(780, 390)
  f.page.onShow()
  await flush()
  assert.deepEqual(f.drawSizes[0], { width: 780, height: 390, pixelRatio: 1.5 })
  resolveOld({ key: 'stale' })
  await flush()
  assert.equal(f.page.data.villaStatus, 'ready')
  assert.ok(f.events.includes('dispose:stale'))
  assert.ok(!f.events.includes('attach:stale'))
  assert.equal(f.events.filter(value => value === 'createRenderer').length, 1)
  const pendingFrame = [...f.frames.values()][0]
  f.page.onHide()
  const eventsBeforeFrame = f.events.length
  pendingFrame()
  assert.equal(f.events.length, eventsBeforeFrame)
  assert.equal(f.frames.size, 0)
  f.page.onShow()
  assert.equal(f.frames.size, 1)
  f.page.onUnload()
})

test('a lost graphics context remounts the canvas and permits a full retry', async () => {
  const f = fixture()
  f.mount()
  await flush()
  f.loseContext()
  f.tick()
  assert.equal(f.page.data.status, 'error')
  assert.equal(f.page.data.mountCanvas, false)
  assert.equal(f.frames.size, 0)
  f.restoreContext()
  f.page.retryLandscape()
  await flush()
  assert.equal(f.page.data.status, 'ready')
  assert.equal(f.page.data.mountCanvas, true)
  assert.equal(f.events.filter(value => value === 'createRenderer').length, 2)
  f.page.onUnload()
})

test('unconfigured production cannot start downloads through the direct 3D route', async () => {
  const f = fixture({ envId: ENV_MAP.release })
  f.mount()
  await flush()
  assert.equal(f.page.data.status, 'unavailable')
  assert.equal(f.page.data.mountCanvas, false)
  assert.deepEqual(f.events, [])
})

test('changing between pinch and single touch establishes a new gesture origin', async () => {
  const f = fixture()
  f.mount()
  await flush()
  const first = [0, 40, 60], moved = [0, 42, 58], second = [1, 62, 58]
  const remaining = [1, 72, 58], orbit = [2, 40, 40]
  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchMove(touchEvent([moved]))
  f.page.onTouchStart(touchEvent([moved, second], [second]))
  f.page.onTouchMove(touchEvent([[0, 32, 58], remaining]))
  f.page.onTouchEnd(touchEvent([remaining], [[0, 32, 58]]))
  f.page.onTouchMove(touchEvent([[1, 75, 58]]))
  f.page.toggleOrbit()
  f.page.onTouchStart(touchEvent([orbit], [orbit]))
  f.page.onTouchMove(touchEvent([[2, 36, 45]]))
  assert.deepEqual(f.events.filter(Array.isArray), [['pan', 2, -2], ['zoom', 2], ['pan', 0, 0], ['pan', 3, 0], ['orbit', -4, 5]])
  f.page.onUnload()
})

test('a finger on a toolbar button does not modify a canvas gesture', async () => {
  const f = fixture()
  f.mount()
  await flush()
  const button = [7, 250, 300], first = [0, 40, 60], moved = [0, 42, 58], second = [1, 62, 58]
  f.page.onTouchStart(touchEvent([button, first], [first]))
  f.page.onTouchMove(touchEvent([button, moved]))
  f.page.onTouchStart(touchEvent([button, moved, second], [second]))
  f.page.onTouchMove(touchEvent([button, [0, 32, 58], [1, 72, 58]]))
  f.page.onTouchCancel(touchEvent([button, [1, 72, 58]], [[0, 32, 58]]))
  f.page.onTouchMove(touchEvent([button, [1, 75, 58]]))
  assert.deepEqual(f.events.filter(Array.isArray), [['pan', 2, -2], ['zoom', 2], ['pan', 0, 0], ['pan', 3, 0]])
  f.page.onUnload()
})

test('switching avatars keeps the active character on screen until the new model is ready', async () => {
  let resolvePrevious, previousOptions, attempts = 0
  const f = fixture({ savedCharacter: 'girl', decode(key, options) {
    if (key === 'boy' && ++attempts === 1) {
      previousOptions = options
      return new Promise(resolve => { resolvePrevious = resolve })
    }
    return { key }
  } })
  f.mount()
  await flush()
  assert.equal(f.page.data.activeCharacter, 'girl')
  assert.ok(!f.events.includes('read:boy'))
  f.page.selectCharacter(choose('boy'))
  await flush()
  assert.equal(f.page.data.characterStatus, 'drawing')
  assert.equal(f.page.data.activeCharacter, 'girl')
  f.page.selectCharacter(choose('girl'))
  assert.equal(previousOptions.isCancelled(), true)
  resolvePrevious({ key: 'stale-boy' })
  await flush()
  assert.ok(f.events.includes('dispose:stale-boy'))
  assert.ok(!f.events.includes('attach:stale-boy'))
  assert.deepEqual(f.selections, ['girl'])
  f.page.selectCharacter(choose('boy'))
  await flush()
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.deepEqual(f.events.filter(event => event === 'attach:girl' || event === 'attach:boy'), ['attach:girl', 'attach:boy'])
  assert.deepEqual(f.selections, ['girl', 'boy'])
  f.page.focusCharacter()
  assert.equal(f.events.at(-1), 'focusCharacter')
  f.page.onUnload()
})

test('a character decode failure keeps the current character and only retries the failed model', async () => {
  let attempts = 0
  const f = fixture({ decode(key) {
    if (key === 'girl' && ++attempts === 1) throw new Error('invalid model')
    return { key }
  } })
  f.mount()
  await flush()
  f.page.selectCharacter(choose('girl'))
  await flush()
  assert.equal(f.page.data.characterStatus, 'error')
  assert.match(f.page.data.characterError, /女孩.*重试/)
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.ok(f.events.includes('invalidate:girl'))
  f.page.retryCharacter()
  await flush()
  assert.equal(f.page.data.characterStatus, 'ready')
  assert.equal(f.page.data.activeCharacter, 'girl')
  for (const key of ['manor', 'villa', 'boy']) assert.equal(f.events.filter(event => event === 'read:' + key).length, 1)
  assert.deepEqual(f.selections, ['boy', 'girl'])
  f.page.onUnload()
})

test('rotating to landscape stops a held joystick and the resized scene accepts new gestures', async () => {
  const f = fixture()
  f.mount()
  await flush()
  const stick = { identifier: 1, clientX: 65, clientY: 350 }
  const moved = { ...stick, clientX: 95 }
  const camera = { identifier: 2, x: 220, y: 200 }
  f.page.onStickStart({ changedTouches: [stick] })
  f.page.onStickMove({ touches: [camera, moved] })
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0, running: false })
  f.page.toggleRun()
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0, running: true })
  f.page.onTouchStart({ touches: [moved, camera], changedTouches: [camera] })
  f.page.onTouchMove({ touches: [moved, { ...camera, x: 225 }] })
  assert.deepEqual(f.events.filter(Array.isArray).at(-1), ['pan', 5, 0])
  f.page.onStickEnd({ changedTouches: [camera] })
  assert.equal(f.page.data.stickActive, true)

  await f.page.onResize({ size: { windowWidth: 780, windowHeight: 390 } })
  assert.deepEqual(f.sizes.at(-1), { width: 780, height: 390, pixelRatio: 1.5 })
  assert.deepEqual(f.inputs.at(-1), { x: 0, y: 0, running: false })
  assert.equal(f.page.data.stickActive, false)
  assert.equal(f.page.data.stickX, 0)
  const inputsAfterRotation = f.inputs.length
  const panBeforeNewTouch = f.events.filter(Array.isArray).length
  f.page.onStickMove({ touches: [moved] })
  f.page.onTouchMove({ touches: [camera] })
  assert.equal(f.inputs.length, inputsAfterRotation)
  assert.equal(f.events.filter(Array.isArray).length, panBeforeNewTouch)
  f.page.onTouchStart({ touches: [camera], changedTouches: [camera] })
  f.page.onTouchMove({ touches: [{ ...camera, y: 211 }] })
  assert.deepEqual(f.events.filter(Array.isArray).at(-1), ['pan', 0, 11])
  f.page.onStickStart({ changedTouches: [moved] })
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0, running: true })
  f.page.onStickCancel()
  assert.deepEqual(f.inputs.at(-1), { x: 0, y: 0, running: false })
  f.page.onUnload()
})

test('an older canvas measurement cannot restore portrait dimensions after rotating', async () => {
  const f = fixture()
  f.mount()
  await flush()
  let finishMeasurement
  f.page._queryCanvas = () => new Promise(resolve => { finishMeasurement = resolve })
  const previousResize = f.page.onResize()
  await f.page.onResize({ size: { windowWidth: 780, windowHeight: 390 } })
  finishMeasurement({ width: 390, height: 780 })
  await previousResize
  assert.deepEqual(f.sizes.at(-1), { width: 780, height: 390, pixelRatio: 1.5 })
  f.page.onUnload()
})

test('resuming during a character decode starts a fresh load and disposes the cancelled model', async () => {
  let resolveOld, oldOptions, attempts = 0
  const f = fixture({ decode(key, options) {
    if (key === 'boy' && ++attempts === 1) {
      oldOptions = options
      return new Promise(resolve => { resolveOld = resolve })
    }
    return { key }
  } })
  f.mount()
  await flush()
  assert.equal(f.page.data.characterStatus, 'drawing')
  f.page.onHide()
  assert.equal(oldOptions.isCancelled(), true)
  assert.equal(f.frames.size, 0)
  f.page.onShow()
  await flush()
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.equal(f.page.data.villaStatus, 'ready')
  resolveOld({ key: 'cancelled-boy' })
  await flush()
  assert.ok(f.events.includes('dispose:cancelled-boy'))
  assert.ok(!f.events.includes('attach:cancelled-boy'))
  assert.equal(f.events.filter(value => value === 'attach:boy').length, 1)
  assert.equal(f.events.filter(value => value === 'read:manor').length, 1)
  assert.equal(f.frames.size, 1)
  f.page.onUnload()
})

test('the title-free page follows screen orientation and can leave when opened directly', () => {
  const f = fixture({ canGoBack: false })
  assert.equal(pageConfig.navigationStyle, 'custom')
  assert.equal(pageConfig.pageOrientation, 'auto')
  assert.ok(!Object.hasOwn(pageConfig, 'navigationBarTitleText'))
  assert.match(markup, /id="manor-stick"[^>]*catchtouchstart="onStickStart"[^>]*catchtouchcancel="onStickCancel"/)
  for (const [, handler] of markup.matchAll(/(?:bind|catch)\w+="(\w+)"/g)) assert.equal(typeof f.page[handler], 'function', handler)
  f.page.goBack()
  assert.deepEqual(f.events, ['back', 'redirect:/packagePlayground/pages/index'])
})
