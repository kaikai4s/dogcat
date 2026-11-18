const { getActiveEnvId } = require('../../envList')
const { createCloudAssets, hasManorAssets } = require('../utils/cloud-assets')
const { THREE, createRenderer, loadGlb, disposeModel } = require('../utils/model-runtime')
const { createManorScene } = require('../utils/manor-scene')

const FRAME_MS = 1000 / 30
const MAX_DRAW_PIXELS = 900000
const CHARACTER_KEY = 'dogcat-manor-3d-character'

function touchPoint(touch) {
  const x = touch.x ?? touch.clientX ?? touch.pageX
  const y = touch.y ?? touch.clientY ?? touch.pageY
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function sample(touches) {
  if (!touches?.length) return null
  const first = touchPoint(touches[0])
  if (!first) return null
  if (touches.length === 1) return { ...first, count: 1 }
  const second = touchPoint(touches[1])
  if (!second) return null
  return {
    count: 2,
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    span: Math.hypot(first.x - second.x, first.y - second.y)
  }
}

function readLayout(text) {
  const layout = JSON.parse(text)
  const { width, depth } = layout?.world || {}
  if (![width, depth].every(value => Number.isFinite(value) && value > 0) ||
      !Array.isArray(layout.plots) || !layout.plots.length || layout.plots.some(plot =>
        !plot || ![plot.x, plot.y, plot.z, plot.width, plot.depth].every(Number.isFinite) ||
        plot.width <= 0 || plot.depth <= 0)) throw new Error('无效的庄园地图布局')
  return layout
}

function statusText(error, fallback) {
  return typeof error?.code === 'string' && error.code.startsWith('MANOR_ASSET_') ? error.message : fallback
}

Page({
  data: {
    status: 'loading',
    mountCanvas: true,
    stage: '正在准备 3D 庄园',
    progress: -1,
    error: '',
    villaStatus: 'pending',
    villaProgress: -1,
    villaError: '',
    characterType: 'boy',
    activeCharacter: '',
    characterStatus: 'pending',
    characterProgress: -1,
    characterError: '',
    orbitMode: false,
    running: false,
    stickX: 0,
    stickY: 0,
    stickActive: false
  },

  onLoad() {
    this._envId = getActiveEnvId()
    if (!hasManorAssets(this._envId)) {
      this.setData({ status: 'unavailable', mountCanvas: false })
      return
    }
    try {
      if (wx.getStorageSync(CHARACTER_KEY) === 'girl') this.setData({ characterType: 'girl' })
    } catch (_) {}
  },

  onReady() {
    this._mounted = true
    this._beginLoad()
  },

  onShow() {
    this._shown = true
    if (this._hasLandscape) {
      this.onResize()
      this._startFrames()
      this._loadCharacter()
    }
    this._beginLoad()
  },

  onHide() {
    this._shown = false
    this._resizeToken = null
    this._resetCanvasTouches()
    this._stopStick()
    this._stopFrames()
    this._stopLoad()
    this._stopLoad('_characterSession')
  },

  onUnload() {
    this._closed = true
    this.onHide()
    this._releaseScene()
  },

  _queryCanvas() {
    return new Promise(resolve => {
      wx.createSelectorQuery().in(this).select('#manor-canvas').fields({ node: true, size: true })
        .exec(rows => resolve(rows?.[0]))
    })
  },

  _resize(view) {
    const { width, height } = view
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const ratio = Math.min(info.pixelRatio || 1, 1.5, Math.sqrt(MAX_DRAW_PIXELS / (width * height)))
    const previous = this._viewport
    if (previous?.width === width && previous.height === height && previous.ratio === ratio) return
    if (this._renderer.getPixelRatio() !== ratio) this._renderer.setPixelRatio(ratio)
    this._scene.resize(width, height)
    this._viewport = { width, height, ratio }
  },

  async onResize(event) {
    if (!this._shown || !this._scene) return
    this._resetCanvasTouches()
    this._stopStick()
    const scene = this._scene
    const resizeToken = this._resizeToken = {}
    try {
      const { windowWidth, windowHeight } = event?.size || {}
      const view = windowWidth > 0 && windowHeight > 0
        ? { width: windowWidth, height: windowHeight } : await this._queryCanvas()
      if (this._shown && scene === this._scene && resizeToken === this._resizeToken &&
          view?.width > 0 && view.height > 0) this._resize(view)
    } catch (error) {
      if (this._shown && scene === this._scene && resizeToken === this._resizeToken) this._failRenderer(error)
    }
  },

  _isCurrent(session) {
    return this._shown && !this._closed && (this._session === session || this._characterSession === session)
  },

  _stopLoad(field = '_session') {
    const session = this[field]
    this[field] = null
    session?.assets.cancel()
  },

  _releaseScene() {
    this._resetCanvasTouches()
    this._scene?.dispose()
    this._renderer?.dispose()
    this._scene = null
    this._renderer = null
    this._canvas = null
    this._viewport = null
    this._hasLandscape = false
    this._hasVilla = false
  },

  _progress(session, field) {
    let last = -1
    return event => {
      const written = event.totalBytesExpectedToWrite > 0
        ? event.totalBytesWritten / event.totalBytesExpectedToWrite * 100 : 0
      const percent = Math.min(100, Math.floor(Math.max(Number(event.progress) || 0, written)))
      if (!this._isCurrent(session) || percent <= 0 || (percent !== 100 && percent - last < 2) || percent === last) return
      last = percent
      this.setData({ [field]: percent })
    }
  },

  async _attach(session, key, progressField, beforeParse, attach) {
    const buffer = await session.assets.read(key, { onProgress: this._progress(session, progressField) })
    if (!this._isCurrent(session)) return false
    beforeParse()
    let group
    try {
      group = await loadGlb(buffer, this._canvas, wx, { isCancelled: () => !this._isCurrent(session) })
    } catch (error) {
      if (this._isCurrent(session)) session.assets.invalidate(key)
      throw error
    }
    if (!this._isCurrent(session)) {
      disposeModel(group)
      return false
    }
    try { attach(group) } catch (error) {
      if (!group.parent) disposeModel(group)
      throw error
    }
    return true
  },

  async _beginLoad() {
    if (!this._shown || !this._mounted || this._closed || this._session ||
        this.data.status === 'unavailable' || this.data.status === 'error' ||
        (this._hasLandscape && (this._hasVilla || this.data.villaStatus === 'error'))) return
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._session = session
    try {
      if (!this._scene) {
        try {
          const view = await this._queryCanvas()
          if (!this._isCurrent(session)) return
          if (!view?.node || !(view.width > 0 && view.height > 0)) throw new Error('无法获取庄园画布')
          this._canvas = view.node
          this._renderer = createRenderer(view.node)
          this._scene = createManorScene({ THREE, renderer: this._renderer, disposeModel })
          this._resize(view)
        } catch (error) {
          if (this._isCurrent(session)) this._failRenderer(error)
          return
        }
      } else if (!this._hasLandscape) {
        // The canvas may have rotated while the terrain download was paused.
        await this.onResize()
        if (!this._isCurrent(session)) return
      }
      if (!this._hasLandscape) {
        this.setData({ stage: '正在读取庄园地图', progress: -1 })
        const text = await session.assets.read('layout')
        if (!this._isCurrent(session)) return
        let layout
        try { layout = readLayout(text) } catch (error) {
          session.assets.invalidate('layout')
          throw error
        }
        this.setData({ stage: '正在下载地形（约 56 MB）' })
        const attached = await this._attach(session, 'manor', 'progress',
          () => this.setData({ stage: '正在绘制草坪、树林和溪流', progress: -1 }),
          model => this._scene.showLandscape(model, layout))
        if (!attached || !this._isCurrent(session)) return
        try { this._draw() } catch (error) {
          this._failRenderer(error)
          return
        }
        this._hasLandscape = true
        this.setData({ status: 'ready' })
        this._startFrames()
        // Give the player priority over the optional villa on first entry.
        await this._loadCharacter()
      }
      if (!this._isCurrent(session) || this._hasVilla || this.data.villaStatus === 'error') return
      this.setData({ villaStatus: 'loading', villaProgress: -1, villaError: '' })
      const attached = await this._attach(session, 'villa', 'villaProgress',
        () => this.setData({ villaStatus: 'drawing', villaProgress: -1 }),
        model => this._scene.showVilla(model))
      if (attached && this._isCurrent(session)) {
        this._hasVilla = true
        this.setData({ villaStatus: 'ready' })
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      console.warn('[manor3d] 加载失败', error?.message)
      if (this._hasLandscape) {
        this.setData({ villaStatus: 'error', villaError: statusText(error, '示范别墅加载失败') })
      } else {
        this._releaseScene()
        this.setData({ status: 'error', error: statusText(error, '庄园地形加载失败，请重试') })
      }
    } finally {
      if (this._session === session) this._stopLoad()
    }
  },

  async _loadCharacter() {
    const { characterType: type, activeCharacter, characterStatus } = this.data
    if (!this._shown || !this._hasLandscape || this._closed || this._characterSession ||
        type === activeCharacter || characterStatus === 'error') return
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._characterSession = session
    const name = type === 'girl' ? '女孩' : '男孩'
    try {
      this.setData({ characterStatus: 'loading', characterProgress: -1, characterError: '' })
      const attached = await this._attach(session, type, 'characterProgress',
        () => this.setData({ characterStatus: 'drawing', characterProgress: -1 }),
        model => this._scene.showCharacter(model))
      if (attached && this._isCurrent(session)) {
        this.setData({ activeCharacter: type, characterStatus: 'ready' })
        try { wx.setStorageSync(CHARACTER_KEY, type) } catch (_) {}
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      console.warn('[manor3d] 角色加载失败', error?.message)
      this.setData({ characterStatus: 'error', characterError: name + '加载失败，请重试' })
    } finally {
      if (this._characterSession === session) this._stopLoad('_characterSession')
    }
  },

  _draw(dt = 0) {
    if (this._renderer.getContext().isContextLost?.()) throw new Error('3D 渲染已中断')
    this._scene.render(this._timeSeconds || 0, dt)
  },

  _failRenderer(error) {
    console.warn('[manor3d] 渲染失败', error?.message)
    this._stopStick()
    this._stopFrames()
    this._stopLoad()
    this._stopLoad('_characterSession')
    this._releaseScene()
    this.setData({ status: 'error', activeCharacter: '', mountCanvas: false, error: '无法显示 3D 庄园，请重试或返回 2D 庄园' })
  },

  _startFrames() {
    if (!this._shown || !this._hasLandscape || this._loop) return
    const canvas = this._canvas
    const native = typeof canvas.requestAnimationFrame === 'function' && typeof canvas.cancelAnimationFrame === 'function'
    const loop = { cancel: native ? id => canvas.cancelAnimationFrame(id) : clearTimeout, handle: null }
    this._loop = loop
    let last = Date.now()
    const schedule = () => {
      loop.handle = native ? canvas.requestAnimationFrame(frame) : setTimeout(frame, Math.ceil(FRAME_MS))
    }
    const frame = () => {
      if (this._loop !== loop || !this._shown) return
      const now = Date.now()
      const elapsed = now - last
      if (elapsed >= FRAME_MS - 2 || elapsed < 0) {
        last = now
        const dt = Math.max(0, Math.min(elapsed, 100)) / 1000
        this._timeSeconds = (this._timeSeconds || 0) + dt
        try { this._draw(dt) } catch (error) {
          this._failRenderer(error)
          return
        }
      }
      schedule()
    }
    schedule()
  },

  _stopFrames() {
    const loop = this._loop
    this._loop = null
    if (loop?.handle != null) loop.cancel(loop.handle)
  },

  retryLandscape() {
    if (this.data.status !== 'error' || !this._shown) return
    this.setData({ status: 'loading', mountCanvas: true, stage: '正在准备 3D 庄园', error: '', progress: -1,
      villaStatus: 'pending', villaProgress: -1, villaError: '', activeCharacter: '', characterStatus: 'pending',
      characterProgress: -1, characterError: '', orbitMode: false, running: false }, () => this._beginLoad())
  },

  retryVilla() {
    if (this.data.villaStatus !== 'error' || !this._shown) return
    this.setData({ villaStatus: 'pending' })
    this._beginLoad()
  },

  selectCharacter(event) {
    const type = event.currentTarget.dataset.character
    if (!this._hasLandscape || !this._shown || (type !== 'boy' && type !== 'girl') || type === this.data.characterType) return
    this._stopLoad('_characterSession')
    this.setData({ characterType: type, characterProgress: -1, characterError: '',
      characterStatus: type === this.data.activeCharacter ? 'ready' : 'pending' })
    this._loadCharacter()
  },

  retryCharacter() {
    if (this.data.characterStatus !== 'error' || !this._shown || !this._hasLandscape) return
    this.setData({ characterStatus: 'pending' })
    this._loadCharacter()
  },

  _resetCanvasTouches() {
    this._canvasTouchIds = null
    this._gesture = null
  },

  _canvasTouches(event) {
    const ids = this._canvasTouchIds
    return ids?.size ? event.touches?.filter(touch => ids.has(touch.identifier)) : null
  },

  onTouchStart(event) {
    if (!this._shown || !this._hasLandscape) return
    const ids = this._canvasTouchIds ??= new Set()
    for (const touch of event.changedTouches || []) {
      if (touch.identifier != null) ids.add(touch.identifier)
    }
    this._gesture = sample(this._canvasTouches(event))
  },

  onTouchMove(event) {
    const previous = this._gesture
    const current = this._gesture = sample(this._canvasTouches(event))
    if (!this._hasLandscape || !previous || !current || previous.count !== current.count) return
    const dx = current.x - previous.x, dy = current.y - previous.y
    if (current.count === 2) {
      if (current.span > 5 && previous.span > 5) this._scene.zoom(current.span / previous.span)
      this._scene.pan(dx, dy, true)
    } else if (this.data.orbitMode) this._scene.orbit(dx, dy)
    else this._scene.pan(dx, dy)
  },

  onTouchEnd(event) {
    if (!event?.touches?.length) return this._resetCanvasTouches()
    for (const touch of event.changedTouches || []) this._canvasTouchIds?.delete(touch.identifier)
    this._gesture = sample(this._canvasTouches(event))
  },

  onTouchCancel(event) { this.onTouchEnd(event) },

  onStickStart(event) {
    if (this._stick || !this._shown || !this.data.activeCharacter) return
    const touch = event.changedTouches?.[0] || event.touches?.[0]
    if (!touch) return
    const stick = this._stick = { id: touch.identifier, touch, x: 0, y: 0 }
    wx.createSelectorQuery().in(this).select('#manor-stick').boundingClientRect().exec(rows => {
      if (this._stick !== stick) return
      const rect = rows?.[0]
      if (!rect || !(rect.width > 0 && rect.height > 0)) return this._stopStick()
      stick.rect = rect
      this._applyStick(stick)
    })
  },

  onStickMove(event) {
    const stick = this._stick
    if (!stick) return
    const touch = event.touches?.find(item => item.identifier === stick.id)
    if (!touch) return
    stick.touch = touch
    if (stick.rect) this._applyStick(stick)
  },

  _applyStick(stick) {
    const { touch, rect } = stick
    const x = (touch.clientX ?? touch.pageX ?? touch.x) - rect.left - rect.width / 2
    const y = (touch.clientY ?? touch.pageY ?? touch.y) - rect.top - rect.height / 2
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const radius = Math.min(rect.width, rect.height) * 0.30
    const divisor = Math.max(radius, Math.hypot(x, y))
    stick.x = x / divisor
    stick.y = y / divisor
    this._scene.setPlayerInput(stick.x, stick.y, this.data.running)
    const stickX = Math.round(stick.x * radius)
    const stickY = Math.round(stick.y * radius)
    if (!this.data.stickActive || this.data.stickX !== stickX || this.data.stickY !== stickY) {
      this.setData({ stickX, stickY, stickActive: true })
    }
  },

  onStickEnd(event) {
    if (!this._stick) return
    if (event.changedTouches?.length && !event.changedTouches.some(touch => touch.identifier === this._stick.id)) return
    this._stopStick()
  },

  onStickCancel() { this._stopStick() },

  _stopStick() {
    if (!this._stick && !this.data.stickActive) return
    this._stick = null
    this._scene?.setPlayerInput(0, 0, false)
    if (!this._closed) this.setData({ stickX: 0, stickY: 0, stickActive: false })
  },

  toggleRun() {
    if (!this._shown || !this.data.activeCharacter) return
    const running = !this.data.running
    this.setData({ running })
    if (this._stick?.rect) this._scene.setPlayerInput(this._stick.x, this._stick.y, running)
  },

  toggleOrbit() { this._gesture = null; this.setData({ orbitMode: !this.data.orbitMode }) },
  resetView() { if (this._hasLandscape) { this._stopStick(); this._scene.resetView() } },
  focusVilla() { if (this._hasVilla) { this._stopStick(); this._scene.focusVilla() } },
  focusCharacter() { if (this.data.activeCharacter) this._scene.focusCharacter() },
  goBack() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/packagePlayground/pages/index' }) }) }
})
