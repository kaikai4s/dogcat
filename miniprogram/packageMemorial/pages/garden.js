const worldIndex = require('../scene/world-index')
const plotLayout = require('../scene/plot-layout')
const buildableCells = worldIndex.cells.filter(p => plotLayout.ids.includes(p.id))
const world = require('../scene/world-template')
const { MemorialScene } = require('../scene/engine')
const { MapGestures } = require('../scene/gestures')
const { GardenSound } = require('../scene/sound')
const { createCloudAssets, createCloudChunks } = require('../scene/cloud-assets')
const { propBox } = require('../scene/terrain')
const { plotNumber } = require('../scene/plot-number')

Page({
  data: { restoring: false, move: null, moveLoading: false, moveError: '', presenceMessage: '正在连接同园访客…', visitorCount: 0, loading: true, error: '', gender: 'boy', changing: false, overview: false,
    offeringBusy: false, offeringStage: '', offeringMessage: '', offeringLoading: false, offeringError: '', offeringStatus: null, offeringTotals: { flower: 0, snack: 0 },
    gardenName: '时光纪念园', gardenAccepting: true, gardenListOpen: false, gardens: [], gardensLoading: false, gardensMore: false, gardensError: '',
    environmentLabel: '', environmentTime: '', environmentError: '', weatherEffects: true,
    grid: false, stickX: 0, stickY: 0, following: true, music: true, effects: true, settingsOpen: false, audioError: '', audioDismissed: false, memorialCard: null,
    selection: null, navigation: null, selectingPlot: false, form: null, formError: '', applications: null, applicationError: '', submitting: false, recordsLoading: false,
    streaming: false, streamError: false, worldLoading: false, hudTop: 48, hudLeft: 14, hudRight: 14 },
  onLoad(options = {}) {
    this._alive = true
    if (!options.gardenId && !options.plotId && !options.moveId && wx.redirectTo) {
      this._choosingEntrance = true
      wx.redirectTo({ url: '/packageMemorial/pages/entrance', fail: () => this.setData({ loading: false, error: '入口未能打开，请重试' }) })
      return
    }
    this.gardenId = options.gardenId || worldIndex.version
    this._focusPlotId = options.plotId || ''
    this._restoring = options.restore === '1'
    this.setData({ restoring: this._restoring })
    this._moveId = options.moveId || ''
    if (this._moveId) this.loadMove()
    this._version = 0
    this.updateInsets()
    try {
      const { getCloudEnv, getCachedUser } = require('../../utils/cloud')
      const { positionKey, safePosition } = require('../scene/saved-position')
      const user = getCachedUser && getCachedUser()
      this._positionKey = positionKey(getCloudEnv && getCloudEnv(), user && (user._id || user.openid), this.gardenId)
      this._savedPosition = this._positionKey ? safePosition(wx.getStorageSync(this._positionKey)) : null
    } catch (_) {}
    this.assets = createCloudAssets(wx)
    this.sound = new GardenSound(() => wx.createInnerAudioContext(), (setting, error, kind) => {
      if (!this._alive) return
      const detail = error && (error.errMsg || error.message) || ''
      this._audioErrors = { ...this._audioErrors, [setting]: { kind, detail } }
      this.setData({ audioDismissed: false })
      this.updateAudioError()
    }, this.assets, (setting, kind) => {
      const failed = (this._audioErrors || {})[setting]
      if (failed && failed.kind === kind) delete this._audioErrors[setting]
      this.updateAudioError()
    })
    Promise.resolve(this.assets('monuments-v1/atlas.png')).then(path => { if (this._alive) this.setData({ styleAtlas: path }) }).catch(() => {})
    this.sound.pause()
    try {
      const saved = wx.getStorageSync('memorial-sound-v1') || {}
      this.setData({ music: typeof saved.music === 'boolean' ? saved.music : true, effects: typeof saved.effects === 'boolean' ? saved.effects : true })
    } catch (_) {}
    try { this.setData({ weatherEffects: wx.getStorageSync('memorial-weather-effects-v1') !== false }) } catch (_) {}
    this.sound.configure(this.data)
    // Warm the file without attempting native playback during page entry.
    if (this.data.music) Promise.resolve().then(() => this._alive && this.assets('audio/music.wav')).catch(() => {})
    this._interruptBegin = () => { this._audioInterrupted = true; this.sound.pause() }
    this._interruptEnd = () => { this._audioInterrupted = false; if (this._visible && this._audioUnlocked) this.sound.resume() }
    if (wx.onAudioInterruptionBegin) wx.onAudioInterruptionBegin(this._interruptBegin)
    if (wx.onAudioInterruptionEnd) wx.onAudioInterruptionEnd(this._interruptEnd)
    try {
      const gender = wx.getStorageSync('memorial-avatar-v1')
      if (gender === 'girl' || gender === 'boy') this.setData({ gender })
    } catch (_) { /* Storage may be unavailable; use the default avatar. */ }
  },
  onReady() { if (this._choosingEntrance) return; this._ready = true; if (this._visible) this.initialize() },
  onShow() {
    if (this._choosingEntrance) return
    this._visible = true
    this.refreshMemorials()
    if (this.data.memorialCard) { this.loadEntrance(); this.loadOfferingStatus() }
    if (this.sound && this._audioUnlocked && !this._audioInterrupted) this.sound.resume()
    if (this.scene && this.scene.ready) { this.scene.start(); this.startPresence() }
    else if (this._ready && !this.scene) this.initialize()
  },
  onHide() {
    if (this._choosingEntrance) return
    this._confirmVersion = (this._confirmVersion || 0) + 1
    this.savePosition()
    this._visible = false
    this.invalidateOfferingStatus()
    this._offeringOperation = (this._offeringOperation || 0) + 1
    this.setData({ offeringBusy: false, offeringStage: '', offeringMessage: '', offeringStatus: null, offeringLoading: false })
    this._entranceRequest = (this._entranceRequest || 0) + 1
    this._entranceVideoId = ''
    this.setData({ entrance: null, entranceLoading: false })
    this.stopPresence()
    this.joystickEnd()
    this.cancelMapGesture()
    if (this.scene) this.scene.pause()
    if (this.sound) this.sound.pause()
  },
  onUnload() {
    if (this._choosingEntrance) { this._alive = false; return }
    this.onHide()
    this._alive = false
    this._version++
    if (this.scene) this.scene.destroy()
    this.scene = null
    if (wx.offAudioInterruptionBegin) wx.offAudioInterruptionBegin(this._interruptBegin)
    if (wx.offAudioInterruptionEnd) wx.offAudioInterruptionEnd(this._interruptEnd)
    if (this.sound) this.sound.destroy()
    if (this.assets) this.assets.dispose()
  },
  onResize() {
    this.updateInsets()
    this.joystickEnd()
    this.cancelMapGesture()
    if (this._ready) this.measure()
  },
  updateInsets() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
    const safe = info.safeArea || {}
    const hudTop = Math.max(safe.top || info.statusBarHeight || 0, menu && menu.bottom || 0) + 8
    this.setData({ hudTop, hudLeft: Math.max(14, (safe.left || 0) + 8),
      hudRight: Math.max(14, (info.windowWidth || 0) - (safe.right || info.windowWidth || 0) + 8) })
    if (this.scene) this.scene.hudTop = hudTop + 48
  },
  leaveGarden() {
    if (this.data.submitting) return
    if (this.data.overview || this.data.selectingPlot) { this.returnToWalk(); return }
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/client/home/index' }) })
  },
  measure(callback) {
    const version = this._version
    const query = wx.createSelectorQuery().in(this)
    query.select('#gardenCanvas').fields({ node: true, size: true, rect: true })
    query.select('#joystick').boundingClientRect()
    query.exec(results => {
      if (!this._alive || version !== this._version) return
      const field = results && results[0]
      this._canvasRect = field
      this._pad = results && results[1]
      if (!field || !field.node || !field.width || !field.height) {
        this.setData({ loading: false, error: '场景画布未准备好，请重试' })
        return
      }
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (callback) callback(field, info.pixelRatio || 1)
      else if (this.scene) this.scene.resize(field.width, field.height, info.pixelRatio || 1)
    })
  },
  initialize() {
    this._moveSelectionStarted = false
    this.stopPresence()
    this._version++
    this.cancelMapGesture()
    this._confirmVersion = (this._confirmVersion || 0) + 1
    this.savePosition()
    if (this.scene) this.scene.destroy()
    this.scene = null
    this.joystickEnd()
    this.setData({ loading: true, error: '', changing: false, overview: false, grid: false, following: true, selectingPlot: false, selection: null })
    this.measure((field, dpr) => {
      const scene = this.scene = new MemorialScene(field.node, {
        position: this._savedPosition, width: field.width, height: field.height, dpr, gender: this.data.gender,
        resolveAsset: this.assets, gardenId: this.gardenId, effectsEnabled: this.data.weatherEffects,
        onEnvironmentChange: environment => {
          if (this._alive) this.setData({ environmentLabel: environment.label, environmentTime: environment.timeText })
        },
        onEnvironmentAssetError: environmentError => { if (this._alive) this.setData({ environmentError }) },
        onPortraitError: () => {
          if (this._alive && this._visible && Date.now() - (this._portraitRetryAt || 0) > 30000) {
            this._portraitRetryAt = Date.now(); this.queueWorldRefresh()
          }
        },
        createCanvas: wx.createOffscreenCanvas ? (width, height) => wx.createOffscreenCanvas({ type: '2d', width, height }) : null,
        onNavigation: state => {
          const previous = this.data.navigation || {}
          if (this._alive && (previous.active !== state.active || previous.arrived !== state.arrived || previous.name !== state.name)) this.setData({ navigation: state })
        },
        loadChunk: createCloudChunks(this.assets, wx),
        onStreamChange: status => {
          if (this._alive && (this.data.streaming !== status.loading || this.data.streamError !== status.failed)) {
            this.setData({ streaming: status.loading, streamError: status.failed })
          }
        },
        onTravel: distance => { if (this.sound) this.sound.travel(distance); if (Date.now() - (this._positionSavedAt || 0) > 3000) this.savePosition() },
        onViewChange: view => {
          if (this._alive && (this.data.overview !== view.overview || this.data.following !== view.following)) this.setData(view)
        }
      })
      if (this._environmentClock) scene.syncEnvironmentClock(...this._environmentClock)
      scene.hudTop = this.data.hudTop + 48
      this.gestures = new MapGestures(scene)
      scene.load().then(() => {
        if (!this._alive || this.scene !== scene) return
        this.setData({ loading: false })
        if (this._worldData) { scene.occupiedPlots = new Set(this._worldData.occupied); scene.setMemorials(this._worldData.memorials) }
        this.focusRequestedPlot()
        this.startMoveSelection()
        if (this._visible) { scene.start(); this.startPresence() }
      }).catch(error => {
        if (this._alive && this.scene === scene) this.setData({ loading: false, error: error.message })
      })
    })
  },
  retry() { if (this._choosingEntrance) { wx.redirectTo({ url: '/packageMemorial/pages/entrance' }); return }; if (this._alive) this.initialize() },
  retryChunks() { if (this.scene) this.scene.retryChunks() },
  async chooseGender(event) {
    const gender = event.currentTarget.dataset.gender
    if (!this.scene || !this.scene.ready || this.data.changing || gender === this.data.gender) return
    const scene = this.scene
    this.joystickEnd()
    this.setData({ changing: true })
    try {
      const changed = await scene.setGender(gender)
      if (!changed || !this._alive || this.scene !== scene) return
      this.setData({ gender })
      try { wx.setStorageSync('memorial-avatar-v1', gender) } catch (_) {}
    } catch (_) {
      if (this._alive && this._visible && this.scene === scene) wx.showToast({ title: '形象加载失败，请重试', icon: 'none' })
    } finally {
      if (this._alive && this.scene === scene) this.setData({ changing: false })
    }
  },
  joystickStart(event) {
    if (!this.scene || !this.scene.ready || this.data.changing || this.data.error) return
    const touch = event.changedTouches && event.changedTouches[0]
    if (!touch || !this._pad || this._touchId !== undefined) return
    this.unlockAudio()
    this._touchId = touch.identifier
    this.cancelMapGesture()
    this.scene.followPlayer()
    this.joystickMove(event)
  },
  joystickMove(event) {
    if (this._touchId === undefined || !this.scene || !this._pad) return
    const touch = (event.touches || []).find(item => item.identifier === this._touchId)
    if (!touch) return
    const pad = this._pad, radius = pad.width * 0.32
    let x = touch.clientX - pad.left - pad.width / 2
    let y = touch.clientY - pad.top - pad.height / 2
    const length = Math.hypot(x, y)
    if (length > radius) { x *= radius / length; y *= radius / length }
    this.scene.setInput(x / radius, y / radius)
    if (!this._stickTime || Date.now() - this._stickTime >= 50) {
      this._stickTime = Date.now(); this.setData({ stickX: x, stickY: y })
    }
  },
  joystickEnd(event) {
    if (event && this._touchId !== undefined && event.changedTouches &&
      !event.changedTouches.some(item => item.identifier === this._touchId)) return
    this._touchId = undefined
    if (this.scene) this.scene.setInput(0, 0)
    this.setData({ stickX: 0, stickY: 0 })
  },
  toggleOverview() {
    if (!this.scene || !this.scene.ready) return
    if (this.scene.overview || this.data.overview || this.data.selectingPlot) { this.returnToWalk(); return }
    this.joystickEnd()
    this.cancelMapGesture()
    if (this.sound) this.sound.chime()
    this.scene.selectedPoint = null
    this.scene.showGrid = false
    this.scene.openOverview()
    this.setData({ overview: true, following: false, selection: null, selectingPlot: false, grid: false })
  },
  returnToWalk() {
    if (!this.scene || !this.scene.ready || this.data.submitting) return
    this.joystickEnd()
    this.cancelMapGesture()
    this.scene.followPlayer()
    this.setData({ overview: false, following: true, selection: null, selectingPlot: false, grid: false, form: null })
  },
  showWholeMap() {
    if (!this.scene || !this.scene.ready) return
    this.cancelMapGesture()
    this.scene.openOverview()
    this.setData({ overview: true, following: false })
  },
  toggleGrid() {
    if (!this.scene || !this.scene.ready) return
    if (this.sound) this.sound.chime()
    this.scene.showGrid = !this.scene.showGrid
    this.scene.draw()
    this.setData({ grid: this.scene.showGrid })
  },
  zoom(event) {
    if (!this.scene || !this.scene.ready) return
    this.joystickEnd()
    this.scene.setZoom(Number(event.currentTarget.dataset.delta))
  },
  resetPosition() {
    if (!this.scene || !this.scene.ready) return
    this.joystickEnd()
    this.scene.reset()
    this.setData({ overview: false, selectingPlot: false, grid: false, selection: null, settingsOpen: false })
  },
  followPlayer() {
    if (!this.scene || !this.scene.ready) return
    this.cancelMapGesture()
    this.returnToWalk()
    if (this.sound) this.sound.chime()
  },
  toggleSettings() { this.joystickEnd(); this.cancelMapGesture(); this.setData({ settingsOpen: !this.data.settingsOpen }); this.unlockAudio() },
  toggleWeatherEffects() {
    const enabled = !this.data.weatherEffects
    this.setData({ weatherEffects: enabled })
    if (this.scene) this.scene.setEffectsEnabled(enabled)
    try { wx.setStorageSync('memorial-weather-effects-v1', enabled) } catch (_) {}
  },
  retryEnvironment() { if (this.scene) this.scene.loadEnvironmentAssets() },
  syncEnvironmentClock(serverTime, sent, received) {
    if (![serverTime, sent, received].every(Number.isFinite) || received < sent || received - sent > 10000) return
    this._environmentClock = [serverTime, sent, received]
    if (this.scene && this.scene.syncEnvironmentClock) this.scene.syncEnvironmentClock(serverTime, sent, received)
  },
  toggleSound(event) {
    if (!this.sound) return
    const setting = event.currentTarget.dataset.setting
    if (!['music', 'effects'].includes(setting)) return
    const enabled = !this.data[setting]
    this.setData({ [setting]: enabled })
    delete (this._audioErrors || {})[setting]
    this.updateAudioError()
    try { wx.setStorageSync('memorial-sound-v1', { music: this.data.music, effects: this.data.effects }) } catch (_) {}
    if (this.sound[setting] !== enabled) this.sound.toggle(setting)
    this.unlockAudio()
  },
  retryAudio() {
    if (!this.sound || this._audioInterrupted) return
    this._audioUnlocked = true
    this.setData({ audioError: '', audioDismissed: false })
    this.sound.pause()
    this.sound.configure(this.data)
    this.sound.resume()
    if (this.data.effects) {
      const failed = (this._audioErrors || {}).effects
      if (failed && failed.kind === 'step') this.sound.play('step', true)
      else this.sound.chime()
    }
  },
  updateAudioError() {
    if (!this._alive) return
    const errors = this._audioErrors || {}, setting = ['music', 'effects'].find(key => this.data[key] && errors[key])
    this.setData({ audioError: setting ? (setting === 'music' ? '音乐' : '音效') + '暂未播放，点击重试声音' : '', audioDetail: setting ? errors[setting].detail : '' })
  },
  dismissAudio() { this.setData({ audioDismissed: true }) },
  unlockAudio() {
    if (!this.sound || !this._visible || this.data.loading || this.data.error || this._audioInterrupted || this._audioUnlocked) return
    this._audioUnlocked = true
    this.sound.resume()
  },
  startPresence() {
    if (!this._visible || !this.scene || !this.scene.ready || !this.scene.applyVisitors) return
    if (this.presence) return
    const { PresenceSync } = require('../scene/presence-sync')
    const { getCloudEnv } = require('../../utils/cloud')
    const scene = this.scene
    const presence = this.presence = new PresenceSync({
      sceneId: this.gardenId || worldIndex.version,
      api: (action, data) => this.api(action, data),
      state: () => ({ x: scene.player.x, y: scene.player.y, gender: scene.gender, direction: scene.direction,
        moving: scene.moving, activity: this.data.memorialCard ? 'remember' : this.data.selectingPlot ? 'select' : scene.overview ? 'map' : 'walk' }),
      watch: (session, onChange, onError) => {
        if (!wx.cloud || !wx.cloud.database) throw new Error('当前环境不支持实时监听')
        const env = typeof getCloudEnv === 'function' ? getCloudEnv() : ''
        return wx.cloud.database(env ? { env } : {}).collection(session.collection)
          .where({ kind: 'scene', sceneId: session.sceneId }).limit(session.shards).watch({ onChange, onError })
      },
      onRecords: (rows, removed) => { if (this.scene === scene && !scene.destroyed) scene.applyVisitors(rows, removed) },
      onStatus: ({ message, count, detail }) => { if (this._alive && this._visible && this.presence === presence) this.setData({ presenceMessage: message, presenceDetail: detail, visitorCount: count }) },
      onWorldChange: () => this.queueWorldRefresh(),
      onClock: (serverTime, sent, received) => { if (this._alive && this.scene === scene) this.syncEnvironmentClock(serverTime, sent, received) }
    })
    presence.start()
  },
  savePosition() {
    if (!this.scene || !this.scene.ready || !this._positionKey) return
    const position = { x: this.scene.player.x, y: this.scene.player.y }
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
    this._savedPosition = position; this._positionSavedAt = Date.now()
    try { wx.setStorageSync(this._positionKey, position) } catch (_) {}
  },
  retryPresence() { this.stopPresence(); this.startPresence() },
  stopPresence() {
    if (this.presence) this.presence.stop()
    this.presence = null
    clearTimeout(this._worldRefreshTimer)
    this._worldRefreshTimer = null
  },
  queueWorldRefresh() {
    if (!this._visible || !this._alive || this._worldRefreshTimer) return
    this._worldRefreshTimer = setTimeout(async () => {
      this._worldRefreshTimer = null
      if (!this._visible || !this._alive) return
      if (this._worldLoading) { this.queueWorldRefresh(); return }
      await this.refreshMemorials()
      if (this._alive && this._visible && this.data.memorialCard) { await this.loadEntrance(); this.loadOfferingStatus() }
      if (this.data.applicationError) this.queueWorldRefresh()
    }, this.data.applicationError ? 4000 : 600)
  },
  api(action, data) { return require('../../utils/cloud').callFunction('memorial', action, { gardenId: this.gardenId || worldIndex.version, ...data }) },
  async refreshMemorials() {
    if (this._worldLoading) return
    this._worldLoading = true
    this.setData({ worldLoading: true })
    try {
      const sent = Date.now(), offeringVersion = this._worldOfferingVersion || 0
      const result = await this.api('world')
      if (offeringVersion !== (this._worldOfferingVersion || 0)) { this.queueWorldRefresh(); return }
      if (!this._alive) return
      this.syncEnvironmentClock(result.serverTime, sent, Date.now())
      this._worldData = result
      if (this.data.memorialCard) {
        const current = result.memorials.find(row => row.applicationId === this.data.memorialCard.applicationId)
        if (current) this.setData({ memorialCard: current })
        else this.closeMemorial()
      }
      if (result.garden) this.setData({ gardenName: result.garden.name, gardenAccepting: result.garden.accepting })
      if (this.scene) this.scene.occupiedPlots = new Set(result.occupied)
      if (this.scene && this.scene.ready) this.scene.setMemorials(result.memorials)
      if (this.data.selection && result.occupied.includes(this.data.selection.plotId)) this.clearSelection()
      this.setData({ applicationError: '' })
      this.focusRequestedPlot()
    } catch (error) { if (this._alive) this.setData({ applicationError: error.message || '位置状态加载失败，请重试' }) }
    finally { this._worldLoading = false; if (this._alive) this.setData({ worldLoading: false }) }
  },
  selectMapPoint(point) {
    if (this.data.selectingPlot && (!this._worldData || this.data.worldLoading || this.data.applicationError)) {
      wx.showToast({ title: '请等位置状态加载完成后再选择', icon: 'none' }); return
    }
    const p = this.scene.screenToMap(point)
    if (p.x < 64 || p.y < 64 || p.x > world.WIDTH - 64 || p.y > world.HEIGHT - 64) return
    const occupied = new Set(this._worldData ? this._worldData.occupied : [])
    const nearest = (rows, radius) => rows.reduce((best, item) => {
      const distance = Math.hypot(item.x - p.x, item.y - p.y)
      return distance < radius && (!best || distance < best.distance) ? { ...item, distance } : best
    }, null)
    const landmark = nearest(world.landmarks.concat(this._worldData ? this._worldData.memorials : []), 130)
    // Hit the actual cell before checking occupancy; never silently select a neighbour.
    const hit = buildableCells.find(cell => Math.abs(cell.x - p.x) <= 24 && Math.abs(cell.y - p.y) <= 24)
    const plot = hit && !occupied.has(hit.id) ? hit : null
    if (this.data.selectingPlot && this.scene.scale < .7) {
      this.scene.openOverview(p)
      this.clearSelection()
      return
    }
    const selection = this.data.selectingPlot ? (plot && { ...plot, name: plot.lawn + ' · ' + plotNumber(plot.id) + '号', plotId: plot.id, plotNumber: plotNumber(plot.id) }) :
      { ...(landmark || p), name: landmark ? landmark.name : '所选位置' }
    if (!selection) { wx.showToast({ title: hit ? '这个位置已被选走，请选绿色空位' : '请选择带编号的绿色空位', icon: 'none' }); return }
    this.scene.selectedPoint = selection
    this.scene.requestDraw()
    this.setData({ selection })
  },
  startNavigation() {
    if (!this.data.selection) return
    if (!this.scene.navigate(this.data.selection, this.data.selection.name)) { wx.showToast({ title: '暂未找到可通行路线，请换个位置', icon: 'none' }); return }
    this.returnToWalk()
  },
  clearSelection() { this.setData({ selection: null }); this.scene.selectedPoint = null; this.scene.requestDraw() },
  cancelNavigation() { if (this.scene) this.scene.cancelNavigation() },
  async choosePlot() {
    if (!this.scene || !this.scene.ready) return
    if (!this.data.gardenAccepting) { wx.showToast({ title: '本园暂停新申请，可选择其他园区', icon: 'none' }); return }
    this.joystickEnd(); this.cancelMapGesture()
    this.setData({ settingsOpen: false, selectingPlot: true, selection: null, overview: true, following: false, grid: true })
    this.scene.showGrid = true
    this.scene.selectedPoint = null
    const occupied = new Set(this._worldData ? this._worldData.occupied : [])
    const nearest = buildableCells.filter(p => !occupied.has(p.id)).reduce((best, p) =>
      !best || Math.hypot(p.x - this.scene.player.x, p.y - this.scene.player.y) < Math.hypot(best.x - this.scene.player.x, best.y - this.scene.player.y) ? p : best, null)
    this.scene.openOverview(nearest || this.scene.player)
    await this.refreshMemorials()
  },
  async loadMove() {
    const id = this._moveId, request = this._moveRequest = (this._moveRequest || 0) + 1
    const current = () => this._alive && id === this._moveId && request === this._moveRequest
    this.setData({ moveLoading: true, moveError: '' })
    try {
      const detail = await this.api(this._restoring ? 'recycleDetail' : 'detail', { id })
      if (!current()) return
      if (!detail.owner) throw new Error('只有主人可以管理这座小筑')
      this.setData({ move: detail })
      this.startMoveSelection()
    } catch (error) { if (current()) this.setData({ moveError: error.message || '小筑资料加载失败，请重试' }) }
    finally { if (current()) this.setData({ moveLoading: false }) }
  },
  startMoveSelection() {
    if (!this.data.move || !this.scene || !this.scene.ready || !this.data.gardenAccepting || this._moveSelectionStarted) return
    this._moveSelectionStarted = true
    this.choosePlot()
  },
  changeMoveGarden() {
    if (this.data.submitting) return
    wx.redirectTo({ url: '/packageMemorial/pages/entrance?moveId=' + encodeURIComponent(this._moveId) + (this._restoring ? '&restore=1' : '') })
  },
  cancelMove() {
    if (this.data.submitting) return
    this._restoring = false
    this._moveId = ''; this._moveRequest = (this._moveRequest || 0) + 1; this._moveSelectionStarted = false
    this.setData({ move: null, moveError: '', moveLoading: false, restoring: false, form: null, formError: '' })
    this.returnToWalk()
  },
  async submitMove() {
    if (!this.data.move || !this.data.form || this.data.submitting) return
    const detail = this.data.move, form = { ...this.data.form }, restoring = this._restoring, version = this._confirmVersion || 0
    this.setData({ submitting: true, formError: '' })
    try {
      const answer = await new Promise((resolve, reject) => wx.showModal({ title: this._restoring ? '确认恢复小筑' : '确认迁移小筑', content: '将“' + detail.petName + (restoring ? '”恢复至' : '”迁至') + this.data.gardenName + ' · ' + form.lawn + ' ' + form.plotNumber + '号。回忆、画像、鲜花零食及当天互动记录全部保留。', confirmText: this._restoring ? '确认恢复' : '确认迁移', success: resolve, fail: reject }))
      if (!answer.confirm || !this._alive || this._visible === false || version !== (this._confirmVersion || 0)) return
      const result = await this.api(this._restoring ? 'restore' : 'relocate', { id: detail.id, locationRevision: detail.locationRevision || 0, requestId: form.requestId, plotId: form.plotId, style: form.style, version: worldIndex.version })
      if (!this._alive) return
      this._worldOfferingVersion = (this._worldOfferingVersion || 0) + 1
      this._moveId = ''; this._moveSelectionStarted = false; this._restoring = false
      this.setData({ move: null, restoring: false, form: null, selection: null, selectingPlot: false })
      this._focusPlotId = result.plotId
      await this.refreshMemorials()
      this.focusRequestedPlot()
      wx.showToast({ title: restoring ? '小筑已恢复' : '小筑已迁入，回忆全部保留', icon: 'none' })
    } catch (error) { if (this._alive) this.setData({ formError: error.message || (restoring ? '恢复失败，请重试' : '迁移失败，请重试') }) }
    finally { if (this._alive) this.setData({ submitting: false }) }
  },
  openRecycle() { wx.navigateTo({ url: '/packageMemorial/pages/recycle' }) },
  manageRecord(e) { wx.navigateTo({ url: '/packageMemorial/pages/memory?id=' + encodeURIComponent(e.currentTarget.dataset.id) }) },
  openApplication() {
    if (this._moveId && !this.data.move) { wx.showToast({ title: '请先加载小筑资料', icon: 'none' }); return }
    const selected = this.data.selection
    if (!selected || !selected.plotId || !this._worldData || this.data.worldLoading || this.data.applicationError || this._worldData.occupied.includes(selected.plotId)) { wx.showToast({ title: '请先刷新位置状态并选择空位', icon: 'none' }); return }
    this.setData({ formError: '', form: { style: this.data.move && this.data.move.style || 'arch', petName: '', epitaph: '', date: '', plotId: selected.plotId, plotNumber: plotNumber(selected.plotId), lawn: selected.lawn, requestId: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2) } })
  },
  chooseStyle(e) { if (this.data.form && !this.data.submitting) this.setData({ 'form.style': e.currentTarget.dataset.style }) },
  inputApplication(e) {
    const field = e.currentTarget.dataset.field
    if (!this.data.move && !this.data.submitting && ['petName', 'epitaph', 'date'].includes(field)) this.setData({ ['form.' + field]: e.detail.value })
  },
  closeApplication() { if (!this.data.submitting) this.setData({ form: null, formError: '', applications: null }) },
  async submitApplication() {
    if (this.data.move) return this.submitMove()
    if (!this.data.form || this.data.submitting) return
    const form = this.data.form
    if (!form.petName.trim() || !form.epitaph.trim() || !form.date) { wx.showToast({ title: '请填写名字、纪念日期和寄语', icon: 'none' }); return }
    this.setData({ submitting: true, formError: '' })
    try {
      await this.api('submit', { ...form, version: worldIndex.version })
      if (!this._alive) return
      this.setData({ form: null, selection: null, selectingPlot: false })
      this.scene.followPlayer()
      this.setData({ overview: false, following: true, grid: false })
      wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
      await this.refreshMemorials(); await this.showApplications()
    } catch (error) { if (this._alive) this.setData({ formError: error.message || '提交失败，请重试' }) }
    finally { if (this._alive) this.setData({ submitting: false }) }
  },
  async showApplications(e) {
    if (this.data.recordsLoading) return
    const more = e && e.currentTarget && e.currentTarget.dataset.more
    this.joystickEnd()
    this.setData({ settingsOpen: false, applications: more ? this.data.applications : [], recordsLoading: true, recordsError: '' })
    try {
      const result = await this.api('listMine', { cursor: more ? this._recordsCursor : '' })
      if (!this._alive) return
      this._recordsCursor = result.cursor
      this.setData({ applications: (more ? this.data.applications : []).concat(result.list.map(row => ({ ...row, plotNumber: plotNumber(row.plotId), statusText: { pending: '待审核', approved: '已安放', rejected: '需调整' }[row.status] }))), recordsMore: result.hasMore })
    } catch (error) { if (this._alive) this.setData({ recordsError: error.message || '加载失败，请重试' }) }
    finally { if (this._alive) this.setData({ recordsLoading: false }) }
  },
  visitMemorial(e) {
    const id = e.currentTarget.dataset.id
    const row = (this.data.applications || []).find(p => p._id === id || p.plotId === e.currentTarget.dataset.plot)
    if (row && row.gardenId && row.gardenId !== (this.gardenId || worldIndex.version)) { this.enterGarden(row.gardenId, row.plotId); return }
    const plot = row && worldIndex.cells.find(p => p.id === row.plotId)
    if (!plot || !this.scene || !this.scene.ready) { wx.showToast({ title: '园区尚未准备好，请稍后重试', icon: 'none' }); return }
    this.joystickEnd(); this.cancelMapGesture()
    this.scene.showGrid = false
    this.scene.openOverview(plot)
    this.scene.selectedPoint = plot
    this.setData({ applications: null, overview: true, selectingPlot: false, grid: false, selection: null,
      memorialCard: { ...plot, date: row.date, name: row.petName, epitaph: row.epitaph, applicationId: row._id } })
    this.loadEntrance(); this.loadOfferingStatus()
  },
  closeMemorial() { this.invalidateOfferingStatus(); this._entranceRequest = (this._entranceRequest || 0) + 1; this.resumeEntranceSound(); this.setData({ memorialCard: null, entrance: null, entranceLoading: false, entranceError: '', offeringStatus: null, offeringLoading: false, offeringError: '' }) },
  invalidateOfferingStatus() {
    this._offeringStatusRequest = (this._offeringStatusRequest || 0) + 1
    clearTimeout(this._offeringResetTimer); this._offeringResetTimer = null
  },
  async loadOfferingStatus() {
    const card = this.data.memorialCard
    if (!card || !card.applicationId || this._visible === false) return
    this.invalidateOfferingStatus()
    const request = this._offeringStatusRequest, id = card.applicationId, same = this.data.offeringStatus && this.data.offeringStatus.id === id
    this.setData({ offeringLoading: true, offeringError: '', offeringStatus: same ? this.data.offeringStatus : null,
      offeringTotals: same ? this.data.offeringTotals : card.offerings || { flower: 0, snack: 0 } })
    const current = () => this._alive && this._visible && request === this._offeringStatusRequest && this.data.memorialCard && this.data.memorialCard.applicationId === id
    try {
      const sent = Date.now(), status = await this.api('offeringStatus', { id })
      if (!current()) return
      this.syncEnvironmentClock(status.serverTime, sent, Date.now())
      this.setData({ offeringStatus: { ...status, id }, offeringTotals: status.counts })
      if (this.scene && this.scene.updateOfferings) this.scene.updateOfferings(id, status.counts, status.display)
      // Reload at the server's next Beijing midnight, independent of phone date settings.
      const remaining = status.resetAt - status.serverTime - (Date.now() - sent) / 2
      if (Number.isFinite(remaining)) this._offeringResetTimer = setTimeout(() => { if (current()) this.loadOfferingStatus() }, Math.max(1000, remaining + 100))
    } catch (error) { if (current()) this.setData({ offeringError: error.message || '心意记录暂未读取，请重试' }) }
    finally { if (current()) this.setData({ offeringLoading: false }) }
  },
  cancelOffering() {
    if (this.data.offeringStage === 'recording' || this.data.offeringStage === 'gesture') return
    this._offeringOperation = (this._offeringOperation || 0) + 1
    if (this.scene && this.scene.cancelOffering) this.scene.cancelOffering()
    this.setData({ offeringBusy: false, offeringStage: '', offeringMessage: '' })
  },
  async giveOffering(e) {
    const kind = e.currentTarget.dataset.kind, card = this.data.memorialCard, status = this.data.offeringStatus, scene = this.scene
    if (!['flower', 'snack'].includes(kind) || this.data.offeringBusy || this.data.offeringLoading || !card || !scene || !scene.ready) return
    if (!status || status.id !== card.applicationId) { this.loadOfferingStatus(); return }
    if (status.given[kind]) return
    const operation = this._offeringOperation = (this._offeringOperation || 0) + 1, id = card.applicationId
    const current = () => this._alive && this._visible && this.scene === scene && operation === this._offeringOperation
    const label = kind === 'flower' ? '鲜花' : '零食'
    this.setData({ offeringBusy: true, offeringStage: 'approach', offeringMessage: '正在走到小筑前…' })
    this.joystickEnd(); this.cancelMapGesture()
    // Reveal the scene so the approach and gesture can be watched in full.
    this.closeMemorial()
    let acknowledged
    const apply = () => {
      if (acknowledged && !scene.destroyed) scene.updateOfferings(id, acknowledged.counts, acknowledged.display)
    }
    try {
      const row = scene.memorials.find(item => item.applicationId === id)
      if (!row) throw new Error('小筑位置已变化，请刷新园区')
      await scene.prepareOffering(row, kind)
      if (!current()) return
      this.setData({ offeringStage: 'recording', offeringMessage: '正在记录这份心意…' })
      const sent = Date.now()
      acknowledged = await this.api('placeOffering', { id, kind, day: status.day })
      this._worldOfferingVersion = (this._worldOfferingVersion || 0) + 1
      if (!current()) return
      this.syncEnvironmentClock(acknowledged.serverTime, sent, Date.now())
      if (!acknowledged.duplicate) {
        this.setData({ offeringStage: 'gesture', offeringMessage: kind === 'flower' ? '献上一束花，愿思念常在。' : '放下一份零食，愿它依旧快乐。' })
        await scene.playOffering(apply)
      }
      apply()
      if (current()) {
        if (this.sound && !acknowledged.duplicate) this.sound.chime()
        wx.showToast({ title: acknowledged.duplicate ? '今天已献过这份心意' : '已献上' + label, icon: 'none' })
      }
    } catch (error) {
      if (current()) wx.showToast({ title: error.message || '心意未能确认，请重新打开小筑查看', icon: 'none' })
    } finally {
      apply()
      if (operation === this._offeringOperation) {
        scene.cancelOffering()
        if (this._alive) this.setData({ offeringBusy: false, offeringStage: '', offeringMessage: '' })
      }
      if (this._alive && this._visible) this.queueWorldRefresh()
    }
  },
  async loadEntrance() {
    const row = this.data.memorialCard
    if (!row || !row.applicationId) return
    const request = this._entranceRequest = (this._entranceRequest || 0) + 1
    this.setData({ entrance: null, entranceLoading: true, entranceError: '' })
    try {
      const result = await this.api('entrance', { id: row.applicationId })
      if (!this._alive || request !== this._entranceRequest) return
      this.setData({ entrance: result })
    } catch (error) { if (this._alive && request === this._entranceRequest) this.setData({ entranceError: error.message || '入口回忆暂时未能读取' }) }
    finally { if (this._alive && request === this._entranceRequest) this.setData({ entranceLoading: false }) }
  },
  previewEntranceImage(e) {
    const urls = (this.data.entrance && this.data.entrance.images || []).map(m => m.url).filter(Boolean)
    if (urls.length) wx.previewImage({ urls, current: e.currentTarget.dataset.url })
  },
  pauseEntranceSound(e) {
    const previous = this._entranceVideoId
    this._entranceVideoId = e.currentTarget.id
    if (previous && previous !== this._entranceVideoId && wx.createVideoContext) wx.createVideoContext(previous, this).pause()
    if (this.sound) this.sound.pause()
  },
  resumeEntranceSound(e) {
    if (e && e.currentTarget.id !== this._entranceVideoId) return
    this._entranceVideoId = ''
    if (this.sound && this._visible && this._audioUnlocked && !this._audioInterrupted) this.sound.resume()
  },
  focusRequestedPlot() {
    if (!this._focusPlotId || !this._worldData || !this.scene || !this.scene.ready) return
    const plot = worldIndex.cells.find(row => row.id === this._focusPlotId)
    this._focusPlotId = ''
    if (!plot) return
    this.joystickEnd(); this.scene.showGrid = true; this.scene.openOverview(plot)
    const selection = { ...plot, name: plot.lawn + ' · ' + plotNumber(plot.id) + '号' }
    this.scene.selectedPoint = selection
    this.setData({ overview: true, following: false, grid: true, selectingPlot: false, selection })
  },
  async showGardens(e) {
    if (this.data.gardensLoading) return
    const more = e && e.currentTarget && e.currentTarget.dataset.more
    this.joystickEnd(); this.cancelMapGesture()
    this.setData({ settingsOpen: false, gardenListOpen: true, gardensLoading: true, gardensError: '', gardens: more ? this.data.gardens : [] })
    try {
      const result = await this.api('listGardens', { cursor: more ? this._gardensCursor : '' })
      if (!this._alive) return
      this._gardensCursor = result.cursor
      this.setData({ gardens: (more ? this.data.gardens : []).concat(result.list), gardensMore: result.hasMore, currentGardenId: this.gardenId || worldIndex.version })
    } catch (error) { if (this._alive) this.setData({ gardensError: error.message || '园区列表加载失败' }) }
    finally { if (this._alive) this.setData({ gardensLoading: false }) }
  },
  closeGardens() { this.setData({ gardenListOpen: false }) },
  chooseGarden(e) { this.enterGarden(e.currentTarget.dataset.id) },
  enterGarden(id, plotId) {
    if (!id || this.data.submitting) return
    if (id === (this.gardenId || worldIndex.version) && !plotId) { this.closeGardens(); return }
    this._confirmVersion = (this._confirmVersion || 0) + 1
    this.savePosition(); this.joystickEnd()
    wx.redirectTo({ url: '/packageMemorial/pages/garden?gardenId=' + encodeURIComponent(id) + (plotId ? '&plotId=' + encodeURIComponent(plotId) : '') + (this._moveId ? '&moveId=' + encodeURIComponent(this._moveId) + (this._restoring ? '&restore=1' : '') : ''),
      fail: () => wx.showToast({ title: '未能切换园区，请重试', icon: 'none' }) })
  },
  openMemory() {
    const row = this.data.memorialCard || this.data.selection
    if (!row || !row.applicationId) { wx.showToast({ title: '请刷新园区后重试', icon: 'none' }); return }
    wx.navigateTo({ url: '/packageMemorial/pages/memory?id=' + encodeURIComponent(row.applicationId),
      fail: () => wx.showToast({ title: '回忆页面未能打开，请重试', icon: 'none' }) })
  },
  selectMemorial(point) {
    const p = this.scene.screenToMap(point)
    const rows = (this._worldData && this._worldData.memorials || []).slice().sort((a, b) => b.y - a.y)
    const hit = rows.find(row => { const box = propBox({ ...row, kind: 'memorial' }); return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height })
    if (hit) { this.joystickEnd(); this.setData({ memorialCard: hit }); this.loadEntrance(); this.loadOfferingStatus(); return true }
    return false
  },
  cancelMapGesture() {
    this._mapTap = null
    this._mapTouchIds = []
    if (this.gestures) this.gestures.reset()
  },
  mapTouchStart(event) {
    if (!this.scene || !this.scene.ready || this.data.error || this.data.offeringBusy || this._touchId !== undefined) return
    this.unlockAudio()
    if (event.touches && event.touches.length === 1) {
      const t = event.touches[0], r = this._canvasRect || {}
      this._mapTap = { x: Number.isFinite(t.clientX) ? t.clientX - (r.left || 0) : t.x, y: Number.isFinite(t.clientY) ? t.clientY - (r.top || 0) : t.y }
    } else this._mapTap = null
    const ids = this._mapTouchIds || []
    ;(event.changedTouches || []).forEach(t => { if (!ids.includes(t.identifier)) ids.push(t.identifier) })
    this._mapTouchIds = ids
    this.mapTouchMove(event)
  },
  mapTouchMove(event) {
    if (!this.gestures || !this._canvasRect || this._touchId !== undefined) return
    const rect = this._canvasRect, ids = this._mapTouchIds || []
    if (this._mapTap) {
      const t = (event.touches || [])[0]
      if (t && this._mapTap) {
        const x = Number.isFinite(t.clientX) ? t.clientX - (rect.left || 0) : t.x
        const y = Number.isFinite(t.clientY) ? t.clientY - (rect.top || 0) : t.y
        if (Math.hypot(x - this._mapTap.x, y - this._mapTap.y) > 8 || event.touches.length > 1) this._mapTap = null
      }
    }
    this.gestures.update((event.touches || []).filter(t => ids.includes(t.identifier)).map(t => ({
      id: t.identifier,
      // Native Canvas2D can emit local x/y rather than view client coordinates.
      x: Number.isFinite(t.clientX) ? t.clientX - (rect.left || 0) : t.x,
      y: Number.isFinite(t.clientY) ? t.clientY - (rect.top || 0) : t.y
    })))
  },
  mapTouchEnd(event) {
    if (this._mapTap) {
      if (this.scene.overview && this.data.selectingPlot) this.selectMapPoint(this._mapTap)
      else if (!this.selectMemorial(this._mapTap) && this.scene.overview) this.selectMapPoint(this._mapTap)
      this._mapTap = null
    }
    const ended = (event.changedTouches || []).map(t => t.identifier)
    this._mapTouchIds = (this._mapTouchIds || []).filter(id => !ended.includes(id))
    this.mapTouchMove(event)
  },
  stopBubble() {}
})
