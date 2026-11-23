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
  decode = key => ({ key }), savedCharacter, savedSensitivity, canGoBack = true, entryTicket, communityScene,
  placeResult = true, syncStart = null, buildPlots = [], buildGround, saveBuilding,
  checkpointStorage = new Map(), asyncPositionWrites, vehicleSyncState = null, petModels = false } = {}) {
  let definition, nextFrame = 0, now = 0, lost = false, pixelRatio = 1
  let sensitivityStorage = savedSensitivity
  let canvasSize = { width: 390, height: 780 }
  let playerPosition = null
  let playerCheckpoint = null
  let vehicleLoaded = false
  const events = [], frames = new Map(), updates = [], inputs = [], sizes = [], drawSizes = [], selections = []
  const communityRequests = [], syncEvents = [], syncInstances = [], placements = [], sharedRecords = [], removedTickets = []
  const vehicleLoads = [], vehicleRecords = []
  const buildPreviews = [], groundPicks = [], placedBuildings = []
  const modals = [], restoredPositions = [], interiorEntries = []
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
      showCharacter(model, type) { playerPosition ??= { x: 0, z: 0 }; events.push('attach:' + model.key + (type ? ':' + type : '')) },
      isInsideVilla: false,
      placeCharacterAt(position) { placements.push(position); if (placeResult) playerPosition = position; return placeResult },
      getPlayerCheckpoint() { return playerCheckpoint },
      restorePlayerPosition(saved) {
        restoredPositions.push(structuredClone(saved))
        playerCheckpoint = structuredClone(saved)
        playerPosition = { x: saved.x, z: saved.z }
        return true
      },
      enterInterior(model, metadata, saved) {
        interiorEntries.push({ model, metadata, saved: structuredClone(saved) })
        this.isInsideVilla = true
        return true
      },
      exitInterior() { this.isInsideVilla = false; return true },
      getVillaEntryState() { return { inside: this.isInsideVilla, nearDoor: false } },
      getPlayerSyncState() { return { position3d: { x: playerPosition?.x || 0, z: playerPosition?.z || 0 }, moving: false, running: false, facing: 0 } },
      setSharedRecords(records) { sharedRecords.push(records) },
      ...(petModels ? { setPetModel(type) { events.push('pet:' + type); return true } } : {}),
      getBuildPlots() { return buildPlots },
      setBuildModel() {},
      setBuildPreview(preview) { buildPreviews.push(structuredClone(preview)) },
      pickBuildGround(...args) { groundPicks.push(args); return buildGround },
      setPlacedBuildings(records) { placedBuildings.push(structuredClone(records)) },
      getMapPlayerPosition() { return playerPosition },
      setPlayerInput(x, y) { inputs.push({ x, y }) },
      dispose() { events.push('disposeScene') }, pan(x, y) { events.push(['pan', x, y]) },
      orbit(x, y) { events.push(['orbit', x, y]) }, zoom(ratio) { events.push(['zoom', ratio]) },
      enterMapView() { events.push('enterMap') }, exitMapView() { events.push('exitMap') }, focusVilla() { events.push('focus') },
      focusCharacter() { events.push('focusCharacter') },
      ...(vehicleSyncState ? {
        showVehicle(model, saved) { vehicleLoaded = true; vehicleLoads.push({ model: model.key, saved: structuredClone(saved) }); return true },
        setVehicleModel(model, saved) { vehicleLoaded = true; vehicleLoads.push({ model: model.key, saved: structuredClone(saved) }); return true },
        setVehicleRecord(record) { vehicleRecords.push(structuredClone(record)); return true },
        getVehicleSyncState() { return vehicleLoaded ? structuredClone(vehicleSyncState) : null }
      } : {})
    }) },
    '../../utils/cloud': {
      async ensureLogin() { communityRequests.push({ type: 'login' }) },
      async callFunction(name, action, data) {
        communityRequests.push({ name, action, data })
        if (action === 'placeManor3dBuilding') {
          assert.equal(typeof saveBuilding, 'function')
          return saveBuilding(data)
        }
        if (action === 'syncManor3dVehicle') return { accepted: true, ackSeq: data.seq, vehicle: { ...data } }
        const scene = typeof communityScene === 'function' ? await communityScene() : communityScene || {
          session: 'session', sceneId: 'community', playerId: 'presence', hasAvatar: true,
          position3d: { x: 12, z: 18 }, community: { name: '青溪花园' }
        }
        // Match the actual playground.enterScene response, where credentials
        // are nested inside an overview alongside unrelated fields.
        return { scene, world: { width: 1200, height: 960 }, pets: [] }
      }
    },
    '../utils/manor-community-sync': {
      ManorCommunitySync: class {
        constructor(scene, applyRecords, onError, onState) {
          this.scene = scene; this.applyRecords = applyRecords; this.onError = onError; this.onState = onState
          this.records = new Map()
          syncInstances.push(this)
        }
        async start() {
          syncEvents.push('start')
          if (typeof syncStart === 'function') return syncStart(this)
          this.onState('connected')
          this.applyRecords([{ id: 'shared-plot', kind: 'plot' }])
          if (syncStart) await syncStart
        }
        syncPosition(state) { syncEvents.push(['position', state]) }
        merge(record) { this.records.set(record.id, record) }
        stop() { syncEvents.push('stop') }
      }
    }
  }
  vm.runInNewContext(source, {
    require: path => { assert.ok(modules[path], path); return modules[path] },
    Page: value => { definition = value }, Date: { now: () => now },
    setTimeout, clearTimeout, console: { warn() {} },
    wx: {
      createSelectorQuery, getWindowInfo: () => ({ pixelRatio: 3 }),
      getMenuButtonBoundingClientRect: () => ({ bottom: canvasSize.height > canvasSize.width ? 82 : 36 }),
      getStorageSync(key) {
        if (key === 'dogcat-manor-3d-character') return savedCharacter
        if (key.startsWith('manor3d:entry:')) return entryTicket
        if (key === 'manor3d-camera-sensitivity') return sensitivityStorage
        return structuredClone(checkpointStorage.get(key))
      },
      removeStorageSync(key) { removedTickets.push(key); checkpointStorage.delete(key) },
      ...(asyncPositionWrites && { setStorage(options) {
        asyncPositionWrites.push({ ...options, success: () => {
          checkpointStorage.set(options.key, structuredClone(options.data))
          options.success()
        } })
      } }),
      setStorageSync(key, value) {
        if (key === 'dogcat-manor-3d-character' || key === 'manor3d-camera-sensitivity') selections.push(value)
        if (key === 'manor3d-camera-sensitivity') sensitivityStorage = value
        else if (key !== 'dogcat-manor-3d-character') checkpointStorage.set(key, structuredClone(value))
      },
      showModal(options) { modals.push(options) },
      navigateBack({ fail }) { events.push('back'); if (!canGoBack) fail() },
      redirectTo({ url }) { events.push('redirect:' + url) }
    }
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(data, callback) {
    updates.push(data); Object.assign(this.data, data); callback?.()
  } }
  return { page, frames, events, updates, inputs, sizes, drawSizes, selections, loseContext() { lost = true }, restoreContext() { lost = false },
    getSavedSensitivity() { return sensitivityStorage }, communityRequests, syncEvents, syncInstances, placements, sharedRecords, removedTickets,
    buildPreviews, groundPicks, placedBuildings, modals, restoredPositions, interiorEntries, vehicleLoads, vehicleRecords,
    setPlayerPosition(x, z) { playerPosition = { x, z } },
    setPlayerCheckpoint(checkpoint) {
      playerCheckpoint = structuredClone(checkpoint)
      playerPosition = { x: checkpoint.x, z: checkpoint.z }
    },
    setCanvasSize(width, height) { canvasSize = { width, height } },
    mount(options = {}) { page.onLoad(options); page.onShow(); page.onReady() },
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
  assert.ok(f.events.indexOf('attach:boy:boy') < f.events.indexOf('read:villa'))
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
  await flush()
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
  const f = fixture({ envId: ENV_MAP.release,
    entryTicket: { community: { name: '青溪花园' }, solo: false, createdAt: 0 } })
  f.mount({ entryKey: 'prodentry' })
  await flush()
  assert.equal(f.page.data.status, 'unavailable')
  assert.equal(f.page.data.mountCanvas, false)
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.communityRequests, [])
  assert.equal(f.removedTickets.length, 1)
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
  assert.equal(f.modals.length, 0)
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

test('switching avatars downloads and attaches the selected cloud model', async () => {
  const f = fixture({ savedCharacter: 'girl' })
  f.mount()
  await flush()
  assert.equal(f.page.data.activeCharacter, 'girl')
  f.page.selectCharacter(choose('boy'))
  await flush()
  assert.equal(f.page.data.characterStatus, 'ready')
  assert.equal(f.page.data.activeCharacter, 'boy')
  f.page.selectCharacter(choose('girl'))
  await flush()
  assert.equal(f.page.data.activeCharacter, 'girl')
  assert.deepEqual(f.events.filter(value => value === 'read:boy' || value === 'read:girl'),
    ['read:girl', 'read:boy', 'read:girl'])
  assert.deepEqual(f.events.filter(value => value.startsWith('attach:') && /:(boy|girl)$/.test(value)),
    ['attach:girl:girl', 'attach:boy:boy', 'attach:girl:girl'])
  assert.deepEqual(f.selections, ['girl', 'boy', 'girl'])
  f.page.selectCharacter(choose('boy'))
  await flush()
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.deepEqual(f.selections, ['girl', 'boy', 'girl', 'boy'])
  f.page.focusCharacter()
  assert.equal(f.events.at(-1), 'focusCharacter')
  f.page.onUnload()
})

test('remote community characters load their matching cloud model', async () => {
  const f = fixture()
  f.mount()
  await flush()
  f.page._scene.setRemoteCharacterModel = (type, model) => {
    f.events.push('remote:' + type + ':' + model.key)
    return true
  }
  f.page._loadRemoteCharacter('girl')
  await flush()
  assert.ok(f.events.includes('read:girl'))
  assert.ok(f.events.includes('remote:girl:girl'))
  f.page.onUnload()
})

test('a cloud character parse failure keeps the current character and retries the requested model', async () => {
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
  f.page.retryCharacter()
  await flush()
  assert.equal(f.page.data.characterStatus, 'ready')
  assert.equal(f.page.data.activeCharacter, 'girl')
  assert.equal(f.events.filter(event => event === 'read:boy').length, 1)
  assert.equal(f.events.filter(event => event === 'read:girl').length, 2)
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

test('resuming the manor keeps the local character and avoids downloading it again', async () => {
  const f = fixture()
  f.mount()
  await flush()
  assert.equal(f.page.data.activeCharacter, 'boy')
  f.page.onHide()
  assert.equal(f.frames.size, 0)
  f.page.onShow()
  await flush()
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.equal(f.page.data.villaStatus, 'ready')
  assert.equal(f.events.filter(value => value === 'read:boy').length, 1)
  assert.equal(f.events.filter(value => value === 'read:boy').length, 1)
  assert.equal(f.events.filter(value => value === 'attach:boy:boy').length, 1)
  assert.equal(f.events.filter(value => value === 'read:manor').length, 1)
  assert.equal(f.frames.size, 1)
  f.page.onUnload()
})

test('resuming restarts pet model downloads cancelled while the page was hidden', async () => {
  let rejectFirstDogRead, dogReads = 0
  const f = fixture({ petModels: true, read(key) {
    if (key === 'dog' && dogReads++ === 0) return new Promise((resolve, reject) => { rejectFirstDogRead = reject })
    return key === 'layout' ? layout : key
  } })
  f.mount()
  for (let attempt = 0; attempt < 12 && dogReads === 0; attempt++) await flush()
  assert.equal(dogReads, 1)
  assert.equal(f.page.data.petModelsStatus, 'loading')

  f.page.onHide()
  assert.equal(f.page.data.petModelsStatus, 'pending')
  f.page.onShow()
  await flush()
  assert.equal(dogReads, 2)
  assert.equal(f.page.data.petModelsStatus, 'ready')

  rejectFirstDogRead(new Error('cancelled old request'))
  await flush()
  assert.equal(f.page.data.petModelsStatus, 'ready')
  assert.equal(dogReads, 2)
  f.page.onUnload()
})

test('resuming reapplies the canvas size before drawing even when the measured size is unchanged', async () => {
  const f = fixture()
  f.mount()
  await flush()
  f.page.onHide()
  const sizesBeforeResume = f.sizes.length
  let finishMeasurement
  f.page._queryCanvas = () => new Promise(resolve => { finishMeasurement = resolve })
  f.page.onShow()
  assert.equal(f.frames.size, 0)
  finishMeasurement({ width: 390, height: 780 })
  await flush()
  assert.equal(f.sizes.length, sizesBeforeResume + 1)
  assert.deepEqual(f.sizes.at(-1), { width: 390, height: 780, pixelRatio: 1.5 })
  assert.equal(f.frames.size, 1)
  f.tick()
  assert.deepEqual(f.drawSizes.at(-1), { width: 390, height: 780, pixelRatio: 1.5 })
  f.page.onUnload()
})

test('a resize event supersedes an unfinished resume measurement', async () => {
  const f = fixture()
  f.mount()
  await flush()
  f.page.onHide()
  let finishMeasurement
  f.page._queryCanvas = () => new Promise(resolve => { finishMeasurement = resolve })
  f.page.onShow()
  await f.page.onResize({ size: { windowWidth: 780, windowHeight: 390 } })
  finishMeasurement({ width: 390, height: 780 })
  await flush()
  assert.deepEqual(f.sizes.at(-1), { width: 780, height: 390, pixelRatio: 1.5 })
  assert.equal(f.frames.size, 1)
  f.page.onUnload()
})

test('the title-free page follows screen orientation and can leave when opened directly', () => {
  const f = fixture({ canGoBack: false })
  assert.equal(pageConfig.navigationStyle, 'custom')
  assert.equal(pageConfig.pageOrientation, 'landscape')
  assert.ok(!Object.hasOwn(pageConfig, 'navigationBarTitleText'))
  assert.match(styles, /\.manor-top-controls\s*\{[^}]*left:\s*calc\(4px \+ env\(safe-area-inset-left\)\);/)
  assert.match(markup, /class="manor-top-controls"[\s\S]*bindtap="toggleMenu"[\s\S]*class="manor-menu"[\s\S]*bindtap="openBuild"/)
  assert.match(markup, /<slider class="manor-sensitivity-slider" min="25" max="150" step="5"/)
  assert.match(markup, /id="manor-stick"[^>]*catchtouchstart="onStickStart"[^>]*catchtouchcancel="onStickCancel"/)
  for (const [, handler] of markup.matchAll(/(?:bind|catch)\w+="(\w+)"/g)) assert.equal(typeof f.page[handler], 'function', handler)
})

test('scene interactions share the right-side action area and the minimap background is translucent', () => {
  const start = markup.indexOf('class="manor-context-actions"')
  const end = markup.indexOf('class="manor-player-action-row"', start)
  const interactions = markup.slice(start, end)
  for (const handler of ['enterVilla', 'exitVilla', 'useRoomDoor', 'useElevator', 'openVehiclePanel']) {
    assert.match(interactions, new RegExp('bindtap="' + handler + '"'))
  }
  assert.doesNotMatch(markup, /class="manor-door-prompt|class="manor-interior-bar/)
  assert.match(styles, /\.manor-context-actions\s*\{[^}]*flex-wrap:\s*wrap;[^}]*gap:/)
  assert.match(styles, /\.manor-minimap\s*\{[^}]*background:\s*rgba\(214, 231, 189, \.72\)/)
})

test('the pet panel only offers cleanup when loose poop can be collected', () => {
  const f = fixture()
  const state = { pets: [{ id: 'pet_1', name: '豆豆', waste: [{ id: 'pee_1', type: 'pee' }] }], selected: null }
  f.page.data.selectedPetId = 'pet_1'
  f.page._scene = { getPetUiState: () => state, getPetInteractionState: () => null }
  f.page._refreshPetUi()
  assert.equal(f.page.data.selectedPet.hasCleanableWaste, false)
  assert.match(markup, /wx:if="\{\{selectedPet\.hasCleanableWaste\}\}"[^>]*bindtap="clearPetWaste"/)

  state.pets[0].waste.push({ id: 'poop_vehicle', type: 'poop', vehicleId: 'car_1' })
  f.page._refreshPetUi()
  assert.equal(f.page.data.selectedPet.hasCleanableWaste, false)
  state.pets[0].waste.push({ id: 'poop_1', type: 'poop' })
  f.page._refreshPetUi()
  assert.equal(f.page.data.selectedPet.hasCleanableWaste, true)
})

test('leaving the manor confirms once, then saves position before going back or redirecting', async () => {
  const f = fixture({ canGoBack: false })
  f.mount()
  await flush()
  f.page._savePlayerPosition = force => f.events.push(['savePosition', force])
  const start = f.events.length

  f.page.goBack()
  f.page.goBack()
  assert.equal(f.modals.length, 1, JSON.stringify({ scene: f.page._communityScene, state: f.page.data,
    hasLandscape: f.page._hasLandscape, hasVilla: f.page._hasVilla, activeCharacter: f.page.data.activeCharacter }))
  f.modals[0].success({ confirm: false })
  f.modals[0].complete()
  assert.deepEqual(f.events.slice(start), [])

  f.page.goBack()
  assert.equal(f.modals.length, 2)
  f.modals[1].success({ confirm: true })
  f.modals[1].complete()
  assert.deepEqual(f.events.slice(start), [['savePosition', true], 'back', 'redirect:/packagePlayground/pages/index'])
  f.page.onUnload()
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

test('the selected community route ticket enters that cloud scene and starts shared position sync', async () => {
  const community = { name: '青溪花园', serviceCommunityId: 'map_community_0123456789abcdef01234567' }
  const scene = { session: 'session', sceneId: 'community-id', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community }
  const f = fixture({ entryTicket: { community, solo: false, createdAt: 0 }, communityScene: scene })
  f.mount({ entryKey: 'abc123' })
  await flush()
  await flush()

  assert.equal(JSON.stringify(f.communityRequests), JSON.stringify([
    { type: 'login' },
    { name: 'playground', action: 'enterScene', data: { manor3d: true, community } }
  ]))
  assert.equal(JSON.stringify(f.removedTickets), JSON.stringify(['manor3d:entry:abc123']))
  assert.equal(JSON.stringify(f.placements), JSON.stringify([scene.position3d]))
  assert.equal(JSON.stringify(f.sharedRecords), JSON.stringify([[{ id: 'shared-plot', kind: 'plot' }]]))
  assert.ok(f.syncEvents.includes('start'))
  assert.equal(f.page.data.communityName, '青溪花园')
  f.tick()
  assert.ok(f.syncEvents.some(event => Array.isArray(event) && event[0] === 'position'))
  f.page.onUnload()
  assert.ok(f.syncEvents.includes('stop'))
})

test('a first-time owner gets the red-tile build prompt and can start construction from it', async () => {
  const community = { name: '松林小区' }
  const f = fixture({ entryTicket: { community, createdAt: 0 }, communityScene: {
    session: 'first-home-session', sceneId: 'first-home-community', playerId: 'first-home-player',
    hasAvatar: false, manor3dCanPublish: true, canBuildManor3d: true, hasAnyManor3dHome: false,
    position3d: null, community
  } })
  f.mount({ entryKey: 'firsthome' })
  await flush()
  await flush()
  await flush()

  assert.equal(f.modals.length, 1)
  assert.match(f.modals[0].content, /松林小区/)
  f.modals[0].success({ confirm: true })
  assert.equal(f.page.data.buildMode, true)
  assert.equal(f.page.data.buildId, 'red_tile_villa')
  f.page.onUnload()
})

test('a user with a house in another community is not prompted and their own car restores and syncs', async () => {
  const community = { name: '青溪花园' }
  const vehicle = { id: 'own-car', communityId: 'community-with-home', position3d: { x: 22, y: 4.1, z: -18 },
    yaw: 1.25, moving: false, seq: 18 }
  const f = fixture({ entryTicket: { community, createdAt: 0 }, vehicleSyncState: {
    position3d: { x: 24, y: 4.1, z: -20 }, yaw: 1.5, moving: true
  }, communityScene: {
    session: 'vehicle-session', sceneId: 'community-with-home', playerId: 'vehicle-owner',
    hasAvatar: false, manor3dCanPublish: true, canBuildManor3d: true, hasAnyManor3dHome: true,
    position3d: null, manor3dVehicle: vehicle, community
  } })
  f.mount({ entryKey: 'owncar' })
  await flush()
  await flush()
  await flush()

  assert.equal(f.modals.length, 0)
  assert.equal(f.page._entrySelected, true)
  assert.equal(f.page._communityScene.manor3dVehicle?.id, vehicle.id, JSON.stringify({
    communityRequests: f.communityRequests, communityScene: f.page._communityScene, loads: f.vehicleLoads
  }))
  assert.deepEqual(f.vehicleLoads, [{ model: 'car', saved: vehicle }])
  assert.equal(f.page._syncManor3dVehicle(true), true)
  const syncCall = f.communityRequests.filter(request => request.action === 'syncManor3dVehicle').at(-1)
  assert.equal(syncCall.data.seq, 19)
  assert.deepEqual(syncCall.data.position3d, { x: 24, y: 4.1, z: -20 })
  assert.equal(syncCall.data.yaw, 1.5)
  assert.equal(syncCall.data.moving, true)
  f.page.onHide()
  const offlineCall = f.communityRequests.filter(request => request.action === 'syncManor3dVehicle').at(-1)
  assert.equal(offlineCall.data.online, false)
  f.page.onUnload()
})

test('retry replaces expired scene credentials and ignores callbacks from the old session', async () => {
  const community = { name: '青溪花园' }
  const scene = { sceneId: 'community-id', playerId: 'presence-id', hasAvatar: true, position3d: { x: 12, z: 18 }, community }
  let attempt = 0, finishOldSync
  const oldSync = new Promise(resolve => { finishOldSync = resolve })
  const f = fixture({ entryTicket: { community, createdAt: 0 },
    communityScene: () => ({ ...scene, session: ++attempt === 1 ? 'expired' : 'fresh' }),
    async syncStart(sync) {
      if (sync.scene.session === 'expired') {
        sync.onError(new Error('场景已切换，请重新进入'))
        await oldSync
        return
      }
      sync.onState('connected')
      sync.applyRecords([{ id: 'fresh-record' }])
    }
  })
  f.mount({ entryKey: 'retrysession' })
  await flush()
  assert.equal(f.page.data.communityStatus, 'error')
  assert.match(f.page.data.communityError, /场景已切换/)
  f.tick()
  assert.ok(!f.syncEvents.some(event => Array.isArray(event) && event[0] === 'position'))

  await f.page.retryCommunity()
  assert.deepEqual(f.syncInstances.map(sync => sync.scene.session), ['expired', 'fresh'])
  assert.ok(f.syncEvents.includes('stop'))
  assert.equal(f.page.data.communityStatus, 'ready')
  assert.equal(f.page.data.communityError, '')
  f.syncInstances[0].onError(new Error('旧请求'))
  f.syncInstances[0].applyRecords([{ id: 'stale-record' }])
  finishOldSync()
  await flush()
  assert.equal(f.page.data.communityStatus, 'ready')
  assert.deepEqual(f.sharedRecords.at(-1), [{ id: 'fresh-record' }])
  f.page.onUnload()
})

test('showing the page again waits for the previous enter to finish before fetching a new session', async () => {
  const community = { name: '青溪花园' }
  const scene = { sceneId: 'community-id', playerId: 'presence-id', hasAvatar: true, position3d: { x: 12, z: 18 }, community }
  let attempt = 0, resolveFirstEnter
  const firstEnter = new Promise(resolve => { resolveFirstEnter = resolve })
  const f = fixture({ entryTicket: { community, createdAt: 0 },
    communityScene: () => ++attempt === 1 ? firstEnter : { ...scene, session: 'new' } })
  f.mount({ entryKey: 'shownagain' })
  await flush()
  assert.equal(attempt, 1)
  f.page.onHide()
  f.page.onShow()
  await flush()
  assert.equal(attempt, 1)

  resolveFirstEnter({ ...scene, session: 'old' })
  await flush()
  assert.equal(attempt, 2)
  assert.deepEqual(f.syncInstances.map(sync => sync.scene.session), ['new'])
  assert.equal(f.page.data.communityStatus, 'ready')
  f.page.onUnload()
})

test('a 3D visitor without a 2D courtyard publishes from the actual 3D spawn', async () => {
  const community = { name: '青溪花园' }
  const f = fixture({ entryTicket: { community, createdAt: 0 }, communityScene: {
    session: 'guest-session', sceneId: 'guest-community', playerId: 'guest', hasAvatar: false,
    manor3dCanPublish: true, position3d: null, community
  } })
  f.mount({ entryKey: 'guest' })
  await flush()
  f.setPlayerPosition(8, -5)
  f.tick()
  assert.equal(f.page.data.communityStatus, 'ready')
  assert.deepEqual(f.placements, [])
  const sent = f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position').at(-1)[1]
  assert.equal(sent.characterType, 'boy')
  assert.equal(sent.position3d.x, 8)
  f.page.onUnload()
})

test('the solo entry route explicitly bypasses the saved residential community', async () => {
  const f = fixture({ entryTicket: { community: null, solo: true, createdAt: 0 } })
  f.mount({ entryKey: 'solo987' })
  await flush()
  await flush()
  assert.equal(JSON.stringify(f.communityRequests[1]), JSON.stringify({
    name: 'playground', action: 'enterScene', data: { manor3d: true, solo: true, community: null }
  }))
  f.page.onUnload()
})

test('hiding saves the character checkpoint and resuming the same page does not move the character', async () => {
  const community = { name: '青溪花园' }
  const scene = { session: 'session', sceneId: 'checkpoint-community', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community }
  const checkpointStorage = new Map()
  const options = { checkpointStorage, entryTicket: { community, createdAt: 0 }, communityScene: scene }
  const f = fixture(options)
  f.mount({ entryKey: 'checkpoint' })
  await flush()
  const checkpoint = { x: 102, y: 4.1, z: 89, facing: .5 }
  f.setPlayerCheckpoint(checkpoint)
  const placements = f.placements.length
  f.page.onHide()

  const reopened = fixture(options)
  reopened.mount({ entryKey: 'checkpoint' })
  await flush()
  const { x, y, z, facing } = reopened.restoredPositions[0] || {}
  assert.deepEqual({ x, y, z, facing }, checkpoint)
  assert.deepEqual(reopened.placements, [])
  reopened.page.onUnload()

  f.page.onShow()
  await flush()
  assert.equal(f.placements.length, placements)
  assert.deepEqual(f.restoredPositions, [])
  assert.deepEqual(f.page._scene.getMapPlayerPosition(), { x, z })
  f.page.onUnload()
})

test('slow local storage keeps rendering and writes only the newest queued checkpoint after unload', async () => {
  const checkpointStorage = new Map(), asyncPositionWrites = []
  const f = fixture({ checkpointStorage, asyncPositionWrites })
  f.mount()
  await flush()
  for (const x of [10, 24, 57]) {
    f.setPlayerCheckpoint({ x, y: 4, z: 5, facing: 0 })
    f.page._savePlayerPosition(true)
    f.tick()
  }
  assert.equal(asyncPositionWrites.length, 1)
  assert.equal(f.page._lastPlayerCheckpoint.x, 57)
  assert.ok(f.events.filter(event => event === 'draw').length >= 3)
  f.setPlayerCheckpoint({ x: 72, y: 4, z: 5, facing: 0 })
  f.page.onUnload()
  asyncPositionWrites[0].success()
  assert.deepEqual(asyncPositionWrites.map(write => write.data.x), [10, 72])
  asyncPositionWrites[1].success()
  assert.equal([...checkpointStorage.values()][0].x, 72)
})

test('unloading saves the latest position for its own community only', async () => {
  const community = { name: '青溪花园' }
  const scene = { session: 'session', sceneId: 'saved-community', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community }
  const checkpointStorage = new Map()
  const options = { checkpointStorage, entryTicket: { community, createdAt: 0 } }
  const f = fixture({ ...options, communityScene: scene })
  f.mount({ entryKey: 'checkpoint' })
  await flush()
  const checkpoint = { x: 121, y: 4.1, z: 96, facing: 1 }
  f.setPlayerCheckpoint(checkpoint)
  f.page.onUnload()

  const otherCommunity = { name: '另一处社区' }
  const other = fixture({ ...options, entryTicket: { community: otherCommunity, createdAt: 0 },
    communityScene: { ...scene, sceneId: 'other-community', community: otherCommunity } })
  other.mount({ entryKey: 'othercheckpoint' })
  await flush()
  assert.deepEqual(other.restoredPositions, [])
  assert.deepEqual(other.placements, [scene.position3d])
  other.page.onUnload()

  const reopened = fixture({ ...options, communityScene: { ...scene, session: 'next-session' } })
  reopened.mount({ entryKey: 'checkpoint' })
  await flush()
  const { x, y, z, facing } = reopened.restoredPositions[0] || {}
  assert.deepEqual({ x, y, z, facing }, checkpoint)
  assert.deepEqual(reopened.placements, [])
  reopened.page.onUnload()
})

test('an indoor checkpoint waits for the villa model instead of using the stale outdoor spawn', async () => {
  const community = { name: '青溪花园' }
  const scene = { session: 'session', sceneId: 'villa-checkpoint', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community }
  const metadata = { model: 'interior.glb', anchors: {
    FrontDoor: { position: [0, 0, 1] }, InteriorSpawn: { position: [0, 0, 0] }
  } }
  const options = { checkpointStorage: new Map(), entryTicket: { community, createdAt: 0 }, communityScene: scene,
    read: key => key === 'layout' ? layout : key === 'interiorModel' ? JSON.stringify(metadata) : key }
  const f = fixture(options)
  f.mount({ entryKey: 'villacp' })
  await flush()
  const liveScene = f.page._scene
  liveScene.getVillaEntryState = () => ({ available: true, nearDoor: !liveScene.isInsideVilla, inside: liveScene.isInsideVilla })
  f.tick()
  f.page.enterVilla()
  await flush()
  assert.equal(f.page.data.insideVilla, true)
  const checkpoint = { x: 10, y: 8.2, z: 19, facing: 1, interior: { kind: 'red' }, exterior: { x: 12, y: 4.1, z: 20 } }
  f.setPlayerCheckpoint(checkpoint)
  f.page.onUnload()

  let resolveInterior
  const interiorDecode = new Promise(resolve => { resolveInterior = resolve })
  const reopened = fixture({ ...options, decode: key => key === 'interior' ? interiorDecode : ({ key }) })
  reopened.mount({ entryKey: 'villacp' })
  await flush()
  assert.ok(reopened.events.includes('read:interior'))
  reopened.tick()
  assert.deepEqual(reopened.placements, [])
  assert.deepEqual(reopened.interiorEntries, [])
  assert.equal(reopened.syncEvents.some(event => event[0] === 'position'), false)

  resolveInterior({ key: 'interior' })
  await flush()
  assert.equal(reopened.page.data.insideVilla, true)
  assert.equal(reopened.interiorEntries.length, 1)
  const { x, y, z, facing, interior, exterior } = reopened.interiorEntries[0].saved
  assert.deepEqual({ x, y, z, facing, interior, exterior }, checkpoint)
  assert.deepEqual(reopened.placements, [])
  reopened.page.onUnload()
})

test('an unwalkable community position stays pending and blocks default-spawn sync', async () => {
  const scene = { session: 'session', sceneId: 'community-id', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community: { name: '青溪花园' } }
  const f = fixture({ entryTicket: { community: scene.community, solo: false, createdAt: 0 }, communityScene: scene, placeResult: false })
  f.mount({ entryKey: 'blockedpos' })
  await flush()
  await flush()

  assert.equal(f.page.data.communityStatus, 'error')
  assert.match(f.page.data.communityError, /可行走地面/)
  assert.deepEqual(f.placements, [scene.position3d])
  f.tick()
  assert.equal(f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position').length, 0)
  assert.deepEqual(f.page._pendingCommunityPosition, scene.position3d)
  f.page.onUnload()
})

test('a slow community snapshot cannot sync the default spawn before server-position placement', async () => {
  let finishSnapshot
  const snapshotGate = new Promise(resolve => { finishSnapshot = resolve })
  const community = { name: '青溪花园' }
  const scene = { session: 'session', sceneId: 'community-id', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community }
  const f = fixture({ entryTicket: { community, solo: false, createdAt: 0 }, communityScene: scene,
    syncStart: async sync => { await snapshotGate; sync.onState('connected') } })
  f.mount({ entryKey: 'slowstart' })
  await flush()
  await flush()
  assert.equal(f.page.data.activeCharacter, 'boy')
  assert.equal(f.page._pendingCommunityPosition, null)
  assert.equal(f.page._communityPositionReady, true)
  assert.equal(f.placements.length, 1)
  f.tick()
  assert.equal(f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position').length, 0)

  finishSnapshot()
  await flush()
  await flush()
  assert.equal(f.page._pendingCommunityPosition, null)
  assert.equal(f.page._communityPositionReady, true)
  assert.equal(f.placements.length, 1)
  f.tick()
  const syncs = f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position')
  assert.equal(syncs.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(syncs[0][1].position3d)), scene.position3d)
  f.page.onUnload()
})

test('3D layout dimensions match the server position projection', async () => {
  const wrongLayout = JSON.stringify({ world: { width: 1000, depth: 960 }, plots: [{ id: 'M01', x: 0, z: 0, y: 4, width: 40, depth: 30 }] })
  const f = fixture({ read: key => key === 'layout' ? wrongLayout : key })
  f.mount()
  await flush()
  await flush()
  assert.equal(f.page.data.status, 'error')
  assert.match(f.page.data.error, /庄园地形加载失败/)
  f.page.onUnload()
})

test('retrying a failed interior load from far away does not download or enter the villa', async () => {
  const f = fixture()
  f.page._shown = true
  f.page._hasVilla = true
  f.page._interiorFailureKind = 'model'
  f.page.data.interiorStatus = 'error'
  let entered = false
  f.page._scene = {
    getVillaEntryState: () => ({ available: true, nearDoor: false }),
    enterInterior() { entered = true },
    dispose() {}
  }
  f.page._interiorModel = {}
  f.page._interiorMetadata = { model: 'interior.glb' }

  f.page.retryInterior()
  await flush()
  assert.match(f.page.data.interiorError, /走到别墅门口/)
  assert.equal(entered, false)
  assert.ok(!f.events.includes('read:interior'))
  f.page.onUnload()
})

test('an outdoor community position waits inside the villa and is applied after exit', () => {
  const f = fixture()
  const scene = f.page._scene = {
    isInsideVilla: true,
    placeCharacterAt(position) { f.placements.push(position); return true },
    exitInterior() { this.isInsideVilla = false; return true },
    getVillaEntryState() { return { nearDoor: false, inside: this.isInsideVilla } },
    dispose() {}
  }
  f.page._shown = true
  f.page._hasLandscape = true
  f.page.data.activeCharacter = 'boy'
  f.page.data.insideVilla = true
  f.page._pendingCommunityPosition = { x: 12, z: 18 }

  assert.equal(f.page._applyPendingCommunityPosition(), false)
  assert.deepEqual(f.placements, [])
  f.page.exitVilla()

  assert.deepEqual(f.placements, [{ x: 12, z: 18 }])
  assert.equal(f.page._pendingCommunityPosition, null)
  assert.equal(f.page._communityPositionPlaced, true)
})

test('the elevator prompt locks movement during a trip, then offers the other direction', () => {
  const f = fixture()
  f.page._shown = true
  Object.assign(f.page.data, { activeCharacter: 'boy', insideVilla: true, interiorStatus: 'ready' })
  let state = { phase: 'ready', targetFloor: 2, busy: false }, started = 0, exited = 0
  f.page._scene = {
    setPlayerInput(x, y) { f.inputs.push([x, y]) },
    getMapPlayerPosition: () => null,
    getElevatorState: () => state,
    useElevator() {
      started++
      state = { phase: 'boarding', targetFloor: 2, busy: true }
      return true
    },
    exitInterior() { exited++; return true }
  }

  f.page._updateElevatorState()
  assert.equal(f.page.data.elevator.destination, '二楼')
  f.page.data.stickActive = true
  f.page.useElevator()
  assert.equal(f.page.data.elevator.title, '正在进电梯')
  assert.equal(f.page.data.stickActive, false)
  assert.deepEqual(f.inputs, [[0, 0]])
  f.page.useElevator()
  f.page.onStickStart(touchEvent([[1, 65, 315]]))
  f.page.exitVilla()
  assert.equal(started, 1)
  assert.equal(exited, 0)
  assert.equal(f.page.data.stickActive, false)

  state = { phase: 'ready', targetFloor: 1, busy: false }
  f.page._updateElevatorState()
  assert.equal(f.page.data.elevator.destination, '一楼')
  f.page.onStickStart(touchEvent([[1, 65, 315]]))
  assert.equal(f.page.data.stickActive, true)
  f.page.exitVilla()
  assert.equal(f.page.data.elevator, null)
  assert.equal(exited, 1)
})

test('community sync reports room and height indoors and clears the room on exit', async () => {
  const community = { name: '青溪花园' }
  const sceneData = { session: 'session', sceneId: 'community-id', playerId: 'presence-id', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community }
  const f = fixture({ entryTicket: { community, solo: false, createdAt: 0 }, communityScene: sceneData })
  f.mount({ entryKey: 'indoorsync' })
  await flush()
  await flush()
  const scene = f.page._scene
  assert.ok(scene)

  scene.isInsideVilla = true
  const outdoorState = scene.getPlayerSyncState
  scene.getPlayerSyncState = () => scene.isInsideVilla ? {
    position3d: { x: 4, y: 8, z: 5 }, interior: { kind: 'red' }, facing: .5
  } : outdoorState()
  f.page.data.insideVilla = true
  f.setPlayerPosition(4, 5)
  const beforeIndoorFrame = f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position').length
  f.tick()
  const positions = () => f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position')
  assert.equal(positions().length, beforeIndoorFrame + 1)
  assert.deepEqual(positions().at(-1)[1].interior, { kind: 'red' })
  assert.equal(positions().at(-1)[1].position3d.y, 8)

  f.setPlayerPosition(12, 18)
  f.page.exitVilla()
  const syncs = f.syncEvents.filter(event => Array.isArray(event) && event[0] === 'position')
  assert.equal(syncs.length, beforeIndoorFrame + 2)
  assert.deepEqual(JSON.parse(JSON.stringify(syncs.at(-1)[1].position3d)), { x: 12, z: 18 })
  f.page.onUnload()
})

async function buildFixture(options) {
  const community = { name: '青溪花园' }
  const scene = { sceneId: 'construction', session: 'fresh', playerId: 'presence', hasAvatar: true,
    position3d: { x: 12, z: 18 }, community, canBuildManor3d: true }
  const f = fixture({ entryTicket: { community, createdAt: 0 }, communityScene: scene,
    buildPlots: JSON.parse(layout).plots, buildGround: { x: .6, z: -.3 }, ...options })
  f.mount({ entryKey: 'build' })
  await flush()
  await flush()
  f.page.openBuild()
  assert.equal(f.page.data.buildMode, true)
  return f
}

test('rotating a courtyard rechecks its selected site and sends the confirmed angle to the cloud', async () => {
  const record = { id: 'courtyard-1', kind: 'manor3dBuilding', buildingId: 'songying_courtyard',
    plotId: 'M01', x: .6, z: -.3, rotation: 270 }
  const f = await buildFixture({ saveBuilding: () => ({ record }) })
  f.page.chooseBuilding({ currentTarget: { dataset: { buildingId: 'songying_courtyard' } } })
  await flush()
  assert.equal(f.page.data.courtyardStatus, 'ready')
  assert.deepEqual(f.buildPreviews.at(-1).regions, [])

  const tap = [1, 195, 375]
  f.page.onTouchStart(touchEvent([tap], [tap]))
  f.page.onTouchEnd(touchEvent([], [tap]))
  assert.equal(f.page.data.buildCanConfirm, false)
  await f.page.confirmBuilding()
  assert.equal(f.communityRequests.some(request => request.action === 'placeManor3dBuilding'), false)

  f.page.rotateBuilding({ currentTarget: { dataset: { delta: '-90' } } })
  assert.deepEqual(f.buildPreviews.at(-1), {
    buildingId: 'songying_courtyard', rotation: 270, plotId: 'M01', x: .6, z: -.3, valid: true,
    regions: [{ plotId: 'M01', minX: -1, maxX: 1, minZ: -1, maxZ: 1 }]
  })
  assert.equal(f.page.data.buildCanConfirm, true)

  await f.page.confirmBuilding()
  assert.deepEqual(structuredClone(f.communityRequests.filter(request => request.action === 'placeManor3dBuilding')), [
    { name: 'playground', action: 'placeManor3dBuilding', data: {
      sceneId: 'construction', session: 'fresh', buildingId: record.buildingId, plotId: 'M01', x: .6, z: -.3, rotation: 270
    } }
  ])
  assert.deepEqual(f.placedBuildings.at(-1), [record])
  assert.equal(f.page.data.buildMode, false)
  assert.equal(f.buildPreviews.at(-1), null)
  f.page.onUnload()
})

test('construction only picks a site on a deliberate canvas tap and cancel discards the preview', async () => {
  const f = await buildFixture()
  const first = [0, 195, 375], second = [1, 255, 375]
  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchMove(touchEvent([[0, 215, 375]]))
  f.page.onTouchEnd(touchEvent([], [first]))
  assert.ok(f.events.some(event => Array.isArray(event) && event[0] === 'orbit'))

  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchStart(touchEvent([first, second], [second]))
  f.page.onTouchEnd(touchEvent([first], [second]))
  f.page.onTouchEnd(touchEvent([], [first]))

  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchCancel(touchEvent([], [first]))
  assert.deepEqual(f.groundPicks, [])
  assert.equal(f.page.data.buildCanConfirm, false)

  f.page.onTouchStart(touchEvent([first], [first]))
  f.page.onTouchEnd(touchEvent([], [[0, 196, 376]]))
  assert.deepEqual(f.groundPicks, [[196, 376, 390, 780]])
  assert.equal(f.page.data.buildCanConfirm, true)
  f.page.goBack()
  assert.equal(f.modals.length, 0)
  await f.page.confirmBuilding()
  assert.equal(f.page.data.buildMode, false)
  assert.equal(f.buildPreviews.at(-1), null)
  assert.equal(f.communityRequests.some(request => request.action === 'placeManor3dBuilding'), false)
  f.page.onUnload()
})
