const worldIndex = require('../scene/world-index')
const world = require('../scene/world-template')
const { MemorialScene } = require('../scene/engine')
const { MapGestures } = require('../scene/gestures')
const { GardenSound } = require('../scene/sound')
const { createCloudAssets, createCloudChunks } = require('../scene/cloud-assets')

Page({
  data: { loading: true, error: '', gender: 'boy', changing: false, overview: false,
    grid: false, stickX: 0, stickY: 0, following: true, music: true, effects: true, settingsOpen: false, audioError: '',
    selection: null, navigation: null, selectingPlot: false, form: null, applications: null, applicationError: '', submitting: false, recordsLoading: false,
    streaming: false, streamError: false },
  onLoad() {
    this._alive = true
    this._version = 0
    this.assets = createCloudAssets(wx)
    this.sound = new GardenSound(() => wx.createInnerAudioContext(), setting => {
      if (!this._alive) return
      this.setData({ audioError: (setting === 'music' ? '音乐' : '音效') + '暂未播放，点击重试声音' })
    }, this.assets)
    this.sound.pause()
    try {
      const saved = wx.getStorageSync('memorial-sound-v1') || {}
      this.setData({ music: typeof saved.music === 'boolean' ? saved.music : true, effects: typeof saved.effects === 'boolean' ? saved.effects : true })
    } catch (_) {}
    this.sound.configure(this.data)
    this._interruptBegin = () => { this._audioInterrupted = true; this.sound.pause() }
    this._interruptEnd = () => { this._audioInterrupted = false; if (this._visible) this.sound.resume() }
    if (wx.onAudioInterruptionBegin) wx.onAudioInterruptionBegin(this._interruptBegin)
    if (wx.onAudioInterruptionEnd) wx.onAudioInterruptionEnd(this._interruptEnd)
    try {
      const gender = wx.getStorageSync('memorial-avatar-v1')
      if (gender === 'girl' || gender === 'boy') this.setData({ gender })
    } catch (_) { /* Storage may be unavailable; use the default avatar. */ }
  },
  onReady() { this._ready = true; if (this._visible) this.initialize() },
  onShow() {
    this._visible = true
    this.refreshMemorials()
    if (this.sound && !this._audioInterrupted) this.sound.resume()
    if (this.scene && this.scene.ready) this.scene.start()
    else if (this._ready && !this.scene) this.initialize()
  },
  onHide() {
    this._visible = false
    this.joystickEnd()
    this.cancelMapGesture()
    if (this.scene) this.scene.pause()
    if (this.sound) this.sound.pause()
  },
  onUnload() {
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
    this.joystickEnd()
    this.cancelMapGesture()
    if (this._ready) this.measure()
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
    this._version++
    this.cancelMapGesture()
    if (this.scene) this.scene.destroy()
    this.scene = null
    this.joystickEnd()
    this.setData({ loading: true, error: '', changing: false, overview: false, grid: false, following: true })
    this.measure((field, dpr) => {
      const scene = this.scene = new MemorialScene(field.node, {
        width: field.width, height: field.height, dpr, gender: this.data.gender,
        resolveAsset: this.assets,
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
        onTravel: distance => { if (this.sound) this.sound.travel(distance) },
        onViewChange: view => {
          if (this._alive && (this.data.overview !== view.overview || this.data.following !== view.following)) this.setData(view)
        }
      })
      this.gestures = new MapGestures(scene)
      scene.load().then(() => {
        if (!this._alive || this.scene !== scene) return
        this.setData({ loading: false })
        if (this._worldData) { scene.occupiedPlots = new Set(this._worldData.occupied); scene.setMemorials(this._worldData.memorials) }
        if (this._visible) scene.start()
      }).catch(error => {
        if (this._alive && this.scene === scene) this.setData({ loading: false, error: error.message })
      })
    })
  },
  retry() { if (this._alive) this.initialize() },
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
    this.joystickEnd()
    this.cancelMapGesture()
    if (this.sound) this.sound.chime()
    this.setData({ overview: this.scene.toggleOverview(), selection: null, selectingPlot: false })
    this.scene.selectedPoint = null
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
    this.setData({ overview: false })
  },
  resetPosition() {
    if (!this.scene || !this.scene.ready) return
    this.joystickEnd()
    this.scene.reset()
    this.setData({ overview: false })
  },
  followPlayer() {
    if (!this.scene || !this.scene.ready) return
    this.cancelMapGesture()
    this.scene.followPlayer()
    if (this.sound) this.sound.chime()
  },
  toggleSettings() { this.joystickEnd(); this.cancelMapGesture(); this.setData({ settingsOpen: !this.data.settingsOpen }); this.unlockAudio() },
  toggleSound(event) {
    if (!this.sound) return
    const setting = event.currentTarget.dataset.setting
    if (!['music', 'effects'].includes(setting)) return
    const enabled = !this.data[setting]
    this.setData({ [setting]: enabled, audioError: '' })
    try { wx.setStorageSync('memorial-sound-v1', { music: this.data.music, effects: this.data.effects }) } catch (_) {}
    if (this.sound[setting] !== enabled) this.sound.toggle(setting)
  },
  retryAudio() { this.setData({ audioError: '' }); this.sound.configure(this.data) },
  unlockAudio() {
    if (this._audioUnlocked || !this.sound || this._audioInterrupted) return
    this._audioUnlocked = true
    if ((this.data.music && !this.sound.music) || (this.data.effects && !this.sound.effects)) this.retryAudio()
    else if (this.data.music) this.sound.play('music')
  },
  api(action, data) { return require('../../utils/cloud').callFunction('memorial', action, data || {}) },
  async refreshMemorials() {
    if (this._worldLoading) return
    this._worldLoading = true
    try {
      const result = await this.api('world')
      if (!this._alive) return
      this._worldData = result
      if (this.scene) this.scene.occupiedPlots = new Set(result.occupied)
      if (this.scene && this.scene.ready) this.scene.setMemorials(result.memorials)
      this.setData({ applicationError: '' })
    } catch (error) { if (this._alive) this.setData({ applicationError: error.message || '墓位状态加载失败，请重试' }) }
    finally { this._worldLoading = false }
  },
  selectMapPoint(point) {
    const p = this.scene.screenToMap(point)
    if (p.x < 64 || p.y < 64 || p.x > world.WIDTH - 64 || p.y > world.HEIGHT - 64) return
    const occupied = new Set(this._worldData ? this._worldData.occupied : [])
    const nearest = (rows, radius) => rows.reduce((best, item) => {
      const distance = Math.hypot(item.x - p.x, item.y - p.y)
      return distance < radius && (!best || distance < best.distance) ? { ...item, distance } : best
    }, null)
    const landmark = nearest(world.landmarks.concat(this._worldData ? this._worldData.memorials : []), 130)
    const plot = nearest(worldIndex.cells.filter(c => !occupied.has(c.id)), 80)
    const selection = this.data.selectingPlot ? (plot && { ...plot, name: plot.lawn + '墓位', plotId: plot.id }) :
      { ...(landmark || p), name: landmark ? landmark.name : '所选位置', ...(plot && !landmark ? { plotId: plot.id, lawn: plot.lawn, x: plot.x, y: plot.y } : {}) }
    if (!selection) { wx.showToast({ title: '请选择草坪上的空闲墓位', icon: 'none' }); return }
    this.scene.selectedPoint = selection
    this.scene.requestDraw()
    this.setData({ selection })
  },
  startNavigation() {
    if (!this.data.selection) return
    if (!this.scene.navigate(this.data.selection, this.data.selection.name)) { wx.showToast({ title: '暂未找到可通行路线，请换个位置', icon: 'none' }); return }
    this.scene.followPlayer()
    this.setData({ selection: null, selectingPlot: false })
  },
  clearSelection() { this.setData({ selection: null }); this.scene.selectedPoint = null; this.scene.requestDraw() },
  cancelNavigation() { if (this.scene) this.scene.cancelNavigation() },
  async choosePlot() {
    if (!this.scene || !this.scene.ready) return
    this.joystickEnd(); this.cancelMapGesture()
    this.setData({ settingsOpen: false, selectingPlot: true, selection: null })
    this.scene.showGrid = true
    if (!this.scene.overview) this.scene.toggleOverview()
    await this.refreshMemorials()
  },
  openApplication() {
    const selected = this.data.selection
    if (!selected || !selected.plotId || !this._worldData || this.data.applicationError) { wx.showToast({ title: '请先刷新墓位状态并选择空位', icon: 'none' }); return }
    this.setData({ form: { petName: '', epitaph: '', date: '', plotId: selected.plotId, lawn: selected.lawn, requestId: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2) } })
  },
  inputApplication(e) {
    const field = e.currentTarget.dataset.field
    if (!this.data.submitting && ['petName', 'epitaph', 'date'].includes(field)) this.setData({ ['form.' + field]: e.detail.value })
  },
  closeApplication() { if (!this.data.submitting) this.setData({ form: null, applications: null }) },
  async submitApplication() {
    if (!this.data.form || this.data.submitting) return
    const form = this.data.form
    if (!form.petName.trim() || !form.epitaph.trim() || !form.date) { wx.showToast({ title: '请填写名字、纪念日期和寄语', icon: 'none' }); return }
    this.setData({ submitting: true })
    try {
      await this.api('submit', { ...form, version: worldIndex.version })
      if (!this._alive) return
      this.setData({ form: null, selection: null, selectingPlot: false })
      wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
      await this.refreshMemorials(); await this.showApplications()
    } catch (error) { if (this._alive) wx.showToast({ title: error.message || '提交失败，请重试', icon: 'none' }) }
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
      this.setData({ applications: (more ? this.data.applications : []).concat(result.list.map(row => ({ ...row, statusText: { pending: '待审核', approved: '已建立', rejected: '未通过' }[row.status] }))), recordsMore: result.hasMore })
    } catch (error) { if (this._alive) this.setData({ recordsError: error.message || '加载失败，请重试' }) }
    finally { if (this._alive) this.setData({ recordsLoading: false }) }
  },
  visitMemorial(e) {
    const row = worldIndex.cells.find(p => p.id === e.currentTarget.dataset.plot)
    if (row && this.scene.navigate(row, '我的纪念碑')) { this.setData({ applications: null }); this.scene.followPlayer() }
  },
  cancelMapGesture() {
    this._mapTap = null
    this._mapTouchIds = []
    if (this.gestures) this.gestures.reset()
  },
  mapTouchStart(event) {
    if (!this.scene || !this.scene.ready || this.data.error || this._touchId !== undefined) return
    this.unlockAudio()
    if (this.scene.overview && event.touches && event.touches.length === 1) {
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
    if (this.scene.overview) {
      const t = (event.touches || [])[0]
      if (t && this._mapTap) {
        const x = Number.isFinite(t.clientX) ? t.clientX - (rect.left || 0) : t.x
        const y = Number.isFinite(t.clientY) ? t.clientY - (rect.top || 0) : t.y
        if (Math.hypot(x - this._mapTap.x, y - this._mapTap.y) > 8 || event.touches.length > 1) this._mapTap = null
      }
      return
    }
    this.gestures.update((event.touches || []).filter(t => ids.includes(t.identifier)).map(t => ({
      id: t.identifier,
      // Native Canvas2D can emit local x/y rather than view client coordinates.
      x: Number.isFinite(t.clientX) ? t.clientX - (rect.left || 0) : t.x,
      y: Number.isFinite(t.clientY) ? t.clientY - (rect.top || 0) : t.y
    })))
  },
  mapTouchEnd(event) {
    if (this._mapTap && this.scene.overview) { this.selectMapPoint(this._mapTap); this._mapTap = null }
    const ended = (event.changedTouches || []).map(t => t.identifier)
    this._mapTouchIds = (this._mapTouchIds || []).filter(id => !ended.includes(id))
    this.mapTouchMove(event)
  },
  stopBubble() {}
})
