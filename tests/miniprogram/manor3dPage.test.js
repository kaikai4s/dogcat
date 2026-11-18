const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { ENV_MAP, hasManorAssets } = require('../../miniprogram/envList')

const source = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/pages/index.js'), 'utf8')
const markup = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/pages/index.wxml'), 'utf8')
const styles = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/pages/index.wxss'), 'utf8')
const pageConfig = require('../../miniprogram/packageManor3d/pages/index.json')
const flush = () => new Promise(resolve => setImmediate(resolve))
const layout = JSON.stringify({ world: { width: 1200, depth: 960 }, plots: [{ id: 'M01', x: 0, z: 0, y: 4.1, width: 40, depth: 30 }] })
const choose = character => ({ currentTarget: { dataset: { character } } })
const touchEvent = (points, changed = []) => {
  const touch = ([identifier, x, y]) => ({ identifier, x, y })
  return { touches: points.map(touch), changedTouches: changed.map(touch) }
}

function fixture({ envId = ENV_MAP.trial, read = key => key === 'layout' ? layout : key,
  decode = key => ({ key }), savedCharacter, savedSensitivity, canGoBack = true } = {}) {
  let definition, nextFrame = 0, now = 0, lost = false, pixelRatio = 1
  let sensitivityStorage = savedSensitivity
  let canvasSize = { width: 390, height: 780 }
  let playerPosition = null
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
    '../utils/manor-minimap': require('../../miniprogram/packageManor3d/utils/manor-minimap'),
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
      showCharacter(model) { playerPosition ??= { x: 0, z: 0 }; events.push('attach:' + model.key) },
      getMapPlayerPosition() { return playerPosition },
      setPlayerInput(x, y) { inputs.push({ x, y }) },
      dispose() { events.push('disposeScene') }, pan(x, y) { events.push(['pan', x, y]) },
      orbit(x, y) { events.push(['orbit', x, y]) }, zoom(ratio) { events.push(['zoom', ratio]) },
      enterMapView() { events.push('enterMap') }, exitMapView() { events.push('exitMap') }, focusVilla() { events.push('focus') },
      focusCharacter() { events.push('focusCharacter') }
    }) }
  }
  vm.runInNewContext(source, {
    require: path => { assert.ok(modules[path], path); return modules[path] },
    Page: value => { definition = value }, Date: { now: () => now },
    setTimeout, clearTimeout, console: { warn() {} },
    wx: {
      createSelectorQuery, getWindowInfo: () => ({ pixelRatio: 3 }),
      getMenuButtonBoundingClientRect: () => ({ bottom: canvasSize.height > canvasSize.width ? 82 : 36 }),
      getStorageSync(key) { return key === 'dogcat-manor-3d-character' ? savedCharacter : sensitivityStorage },
      setStorageSync(key, value) {
        selections.push(value)
        if (key === 'manor3d-camera-sensitivity') sensitivityStorage = value
      },
      navigateBack({ fail }) { events.push('back'); if (!canGoBack) fail() },
      redirectTo({ url }) { events.push('redirect:' + url) }
    }
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(data, callback) {
    updates.push(data); Object.assign(this.data, data); callback?.()
  } }
  return { page, frames, events, updates, inputs, sizes, drawSizes, selections, loseContext() { lost = true }, restoreContext() { lost = false },
    getSavedSensitivity() { return sensitivityStorage },
    setPlayerPosition(x, z) { playerPosition = { x, z } },
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
  assert.equal(f.page.data.mapMode, true)
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
  f.page.openMap()
  f.loseContext()
  f.tick()
  assert.equal(f.page.data.status, 'error')
  assert.equal(f.page.data.mapMode, false)
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

test('map gestures separate same-direction panning from pinch zoom and avatar mode never pans', async () => {
  const f = fixture()
  f.mount()
  await flush()
  const first = [0, 40, 50], second = [1, 60, 50]
  f.page.onTouchStart(touchEvent([first, second], [first, second]))
  f.page.onTouchMove(touchEvent([[0, 45, 60], [1, 65, 60]]))
  f.page.onTouchMove(touchEvent([[0, 35, 60], [1, 75, 60]]))
  f.page.openMap()
  f.page.onTouchMove(touchEvent([[0, 38, 60], [1, 78, 60]]))
  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchMove(touchEvent([[0, 40, 48]]))
  const other = [1, 60, 48]
  f.page.onTouchStart(touchEvent([[0, 40, 48], other], [other]))
  f.page.onTouchMove(touchEvent([[1, 67, 54], [0, 47, 54]]))
  f.page.onTouchEnd(touchEvent([], [[0, 47, 54], [1, 67, 54]]))
  f.page.onTouchStart(touchEvent([first, second], [first, second]))
  f.page.onTouchMove(touchEvent([[0, 34, 50], [1, 74, 50]]))
  f.page.onTouchEnd(touchEvent([[0, 34, 50]], [[1, 74, 50]]))
  f.page.onTouchMove(touchEvent([[0, 40, 49]]))
  assert.deepEqual(f.events.filter(Array.isArray), [
    ['zoom', 2], ['orbit', 0, -1], ['pan', 7, 6], ['zoom', 2], ['orbit', 3, -.5]
  ])
  f.page.onUnload()
})

test('opening the minimap stops the held joystick and returning restores avatar controls', async () => {
  const f = fixture()
  f.mount()
  await flush()
  assert.equal(f.page.data.minimapTop, 90)
  assert.equal(f.page.data.minimap.plots[0].id, 'M01')
  assert.deepEqual(f.page.data.mapPlayer, { x: 50, y: 50 })
  const stick = { identifier: 1, clientX: 95, clientY: 350 }
  f.page.onStickStart({ changedTouches: [stick] })
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0 })
  f.setPlayerPosition(120, -96)
  f.tick()
  assert.deepEqual(f.page.data.mapPlayer, { x: 60, y: 40 })
  f.page.toggleMenu()
  f.page.openMap()
  assert.equal(f.page.data.mapMode, true)
  assert.equal(f.page.data.menuOpen, false)
  assert.equal(f.page.data.stickActive, false)
  assert.deepEqual(f.inputs.at(-1), { x: 0, y: 0 })
  f.page.onStickStart({ changedTouches: [stick] })
  assert.deepEqual(f.inputs.at(-1), { x: 0, y: 0 })
  f.page.goBack()
  assert.equal(f.events.at(-1), 'exitMap')
  assert.equal(f.page.data.mapMode, false)
  f.page.onStickStart({ changedTouches: [stick] })
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0 })
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
  assert.deepEqual(f.events.filter(Array.isArray), [['orbit', 1, -1], ['zoom', 2], ['orbit', 1.5, 0]])
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
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0 })
  f.page.onTouchStart({ touches: [moved, camera], changedTouches: [camera] })
  f.page.onTouchMove({ touches: [moved, { ...camera, x: 225 }] })
  assert.deepEqual(f.events.filter(Array.isArray).at(-1), ['orbit', 2.5, 0])
  f.page.onStickEnd({ changedTouches: [camera] })
  assert.equal(f.page.data.stickActive, true)

  await f.page.onResize({ size: { windowWidth: 780, windowHeight: 390 } })
  assert.deepEqual(f.sizes.at(-1), { width: 780, height: 390, pixelRatio: 1.5 })
  assert.deepEqual(f.inputs.at(-1), { x: 0, y: 0 })
  assert.equal(f.page.data.stickActive, false)
  assert.equal(f.page.data.stickX, 0)
  const inputsAfterRotation = f.inputs.length
  const gesturesBeforeNewTouch = f.events.filter(Array.isArray).length
  f.page.onStickMove({ touches: [moved] })
  f.page.onTouchMove({ touches: [camera] })
  assert.equal(f.inputs.length, inputsAfterRotation)
  assert.equal(f.events.filter(Array.isArray).length, gesturesBeforeNewTouch)
  f.page.onTouchStart({ touches: [camera], changedTouches: [camera] })
  f.page.onTouchMove({ touches: [{ ...camera, y: 211 }] })
  assert.deepEqual(f.events.filter(Array.isArray).at(-1), ['orbit', 0, 5.5])
  f.page.onStickStart({ changedTouches: [moved] })
  assert.deepEqual(f.inputs.at(-1), { x: 1, y: 0 })
  f.page.onStickCancel()
  assert.deepEqual(f.inputs.at(-1), { x: 0, y: 0 })
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
  assert.match(styles, /\.manor-top-controls\s*\{[^}]*left:\s*0;/)
  assert.match(styles, /\.manor-controls\s*\{[^}]*right:\s*env\(safe-area-inset-right\);[^}]*bottom:\s*env\(safe-area-inset-bottom\);/)
  assert.match(markup, /<slider class="manor-sensitivity-slider" min="25" max="150" step="5"/)
  assert.match(markup, /id="manor-stick"[^>]*catchtouchstart="onStickStart"[^>]*catchtouchcancel="onStickCancel"/)
  for (const [, handler] of markup.matchAll(/(?:bind|catch)\w+="(\w+)"/g)) assert.equal(typeof f.page[handler], 'function', handler)
  f.page.goBack()
  assert.deepEqual(f.events, ['back', 'redirect:/packagePlayground/pages/index'])
})

test('camera sensitivity defaults to half speed, applies immediately, and persists within bounds', async () => {
  const f = fixture()
  f.mount()
  await flush()
  assert.equal(f.page.data.cameraSensitivity, 50)
  const first = [0, 40, 50]
  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchMove(touchEvent([[0, 48, 60]]))
  assert.deepEqual(f.events.filter(Array.isArray).at(-1), ['orbit', 4, 5])

  f.page.onCameraSensitivityChanging({ detail: { value: 125 } })
  const next = [1, 48, 60]
  f.page.onTouchStart(touchEvent([next], [next]))
  f.page.onTouchMove(touchEvent([[1, 56, 68]]))
  assert.deepEqual(f.events.filter(Array.isArray).at(-1), ['orbit', 10, 10])

  f.page.onCameraSensitivityChange({ detail: { value: 152 } })
  assert.equal(f.page.data.cameraSensitivity, 150)
  assert.equal(f.selections.at(-1), 150)
  f.page.onUnload()

  const restored = fixture({ savedSensitivity: f.getSavedSensitivity() })
  restored.mount()
  await flush()
  assert.equal(restored.page.data.cameraSensitivity, 150)
  restored.page.onUnload()

  const preset = fixture({ savedSensitivity: 80 })
  preset.mount()
  await flush()
  assert.equal(preset.page.data.cameraSensitivity, 80)
  preset.page.onUnload()
})
