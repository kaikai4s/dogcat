const G = require('./geometry')
const layout = require('./layout')
const { ChunkStream } = require('./chunks')
const { drawGround, drawProp, propBox, drawPlan } = require('./terrain')
const worldIndex = require('./world-index')
const { findRoute, clearLine } = require('./navigation')
const { GroundCache } = require('./ground-cache')
const clamp = (n, a, b) => Math.max(a, Math.min(b, n))
const ASSETS = '/packageMemorial/assets/'

function loadImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage()
    const timeout = setTimeout(() => finish(new Error('园区图片加载超时，请重试')), 15000)
    function finish(error) {
      clearTimeout(timeout)
      img.onload = img.onerror = null
      if (error) reject(error)
      else resolve(img)
    }
    img.onload = () => finish()
    img.onerror = () => finish(new Error('园区图片未能加载，请重试'))
    img.src = src
  })
}

class MemorialScene {
  constructor(canvas, options) {
    options = options || {}
    this.canvas = canvas
    // Mini-program injects cloud downloads; explicit local adapter is for preview.
    this.resolveAsset = options.resolveAsset || (key => ASSETS + key)
    this.ctx = canvas.getContext('2d')
    this.ground = new GroundCache(options.createCanvas)
    this.map = layout
    this.cells = []
    this.objects = []
    this.memorials = []
    this.route = []
    this.onNavigation = options.onNavigation || (() => {})
    this.onStreamChange = options.onStreamChange || (() => {})
    this.chunks = options.loadChunk ? new ChunkStream(options.loadChunk, () => {
      this.objects = this.chunks.objects()
      this.cells = this.chunks.cells()
      this.onStreamChange(this.chunks.status())
      if (this.ready && !this.running) this.requestDraw()
    }) : null
    this.player = Object.assign({}, layout.spawn)
    this.direction = 'sw'
    this.gender = options.gender === 'girl' ? 'girl' : 'boy'
    this.images = {}
    this.pending = {}
    this.input = { x: 0, y: 0 }
    this.camera = Object.assign({}, layout.spawn)
    this.following = true
    this.onViewChange = options.onViewChange || (() => {})
    this.onTravel = options.onTravel || (() => {})
    this.zoom = 1
    this.overview = false
    this.showGrid = false
    this.walkPhase = 0
    this.idleTime = 0
    this.moving = false
    this.running = false
    this.destroyed = false
    this.ready = false
    this.changeVersion = 0
    this.resize(options.width || 375, options.height || 700, options.dpr || 1)
  }
  resize(width, height, dpr) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.dpr = Math.min(dpr || this.dpr || 1, 2)
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
    this.minZoom = Math.max(.04, Math.min((this.width - 24) / G.WIDTH, (this.height - (this.width > this.height ? 80 : 180)) / G.HEIGHT))
    this.zoom = clamp(this.zoom, this.minZoom, 1.8)
    this.updateCamera(1, true)
    if (this.ready) this.requestDraw()
  }
  image(key) {
    if (this.images[key]) return Promise.resolve(this.images[key])
    if (!this.pending[key]) {
      const source = this.resolveAsset(key)
      const decode = path => {
        if (this.destroyed) throw new Error('纪念园场景已关闭')
        return loadImage(this.canvas, path)
      }
      this.pending[key] = (typeof source === 'string' ? decode(source) : source.then(decode)).then(img => {
        delete this.pending[key]
        if (!this.destroyed) this.images[key] = img
        return img
      }, error => {
        delete this.pending[key]
        if (this.resolveAsset.invalidate) this.resolveAsset.invalidate(key)
        throw error
      })
    }
    return this.pending[key]
  }
  loadGender(gender) {
    return Promise.all(['walk', 'idle'].map(action => Promise.all(['sw', 'se', 'nw', 'ne'].map(dir =>
      this.image(gender + '/' + action + '-' + dir + '.png')))))
  }
  async load() {
    await Promise.all([this.image('world-v2/props.png'), this.image('world-v2/grass.jpg'), this.loadGender(this.gender),
      this.chunks ? this.chunks.warm(this.viewBounds()) : Promise.resolve()])
    if (this.destroyed) return
    this.ready = true
    this.requestDraw()
  }
  async setGender(gender) {
    if (gender !== 'girl' && gender !== 'boy') return false
    const version = ++this.changeVersion
    this.setInput(0, 0)
    await this.loadGender(gender)
    if (this.destroyed || version !== this.changeVersion) return false
    this.gender = gender
    this.walkPhase = this.idleTime = 0
    this.requestDraw()
    return true
  }
  setInput(x, y) {
    if (this.overview || this.destroyed) x = y = 0
    const length = Math.hypot(x, y)
    this.input = length > 0.12 ? { x: x / Math.max(1, length), y: y / Math.max(1, length) } : { x: 0, y: 0 }
    if (!this.input.x && !this.input.y) this.moving = false
  }
  step(seconds) {
    const dt = clamp(seconds, 0, 0.05)
    const before = Object.assign({}, this.player)
    const screen = G.project(before)
    const aim = G.unproject({ x: screen.x + this.input.x, y: screen.y + this.input.y })
    const dx = aim.x - before.x, dy = aim.y - before.y
    const length = Math.hypot(dx, dy)
    if (length > 1e-6 && !this.overview) {
      const travel = 120 * dt * Math.min(1, Math.hypot(this.input.x, this.input.y))
      const count = Math.max(1, Math.ceil(travel / 2))
      const vx = dx / length * travel / count, vy = dy / length * travel / count
      for (let i = 0; i < count; i++) {
        const next = { x: this.player.x + vx, y: this.player.y + vy }
        if (this.canWalk(next)) this.player = next
        else {
          const horizontal = { x: this.player.x + vx, y: this.player.y }
          if (Math.abs(vx) > 1e-7 && this.canWalk(horizontal)) this.player = horizontal
          const vertical = { x: this.player.x, y: this.player.y + vy }
          if (Math.abs(vy) > 1e-7 && this.canWalk(vertical)) this.player = vertical
        }
      }
    }
    const moved = G.distance(before, this.player)
    const wasMoving = this.moving
    this.moving = moved > 0.001
    if (this.moving) this.onTravel(moved)
    if (this.moving) {
      const after = G.project(this.player)
      const sx = after.x - screen.x, sy = after.y - screen.y
      // Hysteresis keeps straight up/down and wall sliding from flipping sides.
      const horizontal = Math.abs(sx) > Math.abs(sy) * 0.14 ? (sx < 0 ? 'w' : 'e') : this.direction[1]
      const vertical = Math.abs(sy) > Math.abs(sx) * 0.14 ? (sy < 0 ? 'n' : 's') : this.direction[0]
      this.direction = vertical + horizontal
      this.walkPhase = (this.walkPhase + moved / 98 * 8) % 8
      this.idleTime = 0
    } else {
      if (wasMoving) this.idleTime = 0
      this.idleTime += dt
    }
    this.updateCamera(dt)
    this.updateNavigation(dt)
  }
  canWalk(p) {
    if (!G.walkable(p, this.map)) return false
    if (this.chunks) {
      // Neighbor-owned buildings can extend across a chunk edge. Wait for their
      // records before allowing the player into that boundary strip.
      for (const dx of [-128, 0, 128]) for (const dy of [-128, 0, 128]) {
        const x = clamp(p.x + dx, 0, G.WIDTH - 1), y = clamp(p.y + dy, 0, G.HEIGHT - 1)
        if (!this.chunks.loadedAt(x, y)) return false
      }
    }
    return !this.objects.concat(this.memorials).some(o => Math.hypot(p.x - o.x, (p.y - o.y) * 1.35) < layout.PROPS[o.kind].radius + 8)
  }
  viewBounds() {
    return { left: Math.max(0, this.camera.x - this.width / this.scale / 2),
      right: Math.min(G.WIDTH, this.camera.x + this.width / this.scale / 2),
      top: Math.max(0, this.camera.y - this.height / this.scale / 2),
      bottom: Math.min(G.HEIGHT, this.camera.y + this.height / this.scale / 2) }
  }
  retryChunks() { if (this.chunks) this.chunks.retry() }
  getFrame() { return this.moving ? Math.floor(this.walkPhase) % 8 : Math.floor(this.idleTime / 0.32) % 8 }
  updateCamera(dt, snap) {
    this.scale = this.overview ? this.minZoom :
      this.zoom
    const p = G.project(this.player)
    const target = this.limitCamera(this.overview ? { x: G.WIDTH / 2, y: G.HEIGHT / 2 } : this.following ? p : this.camera)
    const blend = snap ? 1 : 1 - Math.exp(-dt * 9)
    this.camera.x += (target.x - this.camera.x) * blend
    this.camera.y += (target.y - this.camera.y) * blend
    this.camera = this.limitCamera(this.camera)
  }
  limitCamera(p) {
    const halfW = this.width / this.scale / 2, halfH = this.height / this.scale / 2
    return {
      x: halfW >= G.WIDTH / 2 ? G.WIDTH / 2 : clamp(p.x, halfW, G.WIDTH - halfW),
      y: halfH >= G.HEIGHT / 2 ? G.HEIGHT / 2 : clamp(p.y, halfH, G.HEIGHT - halfH)
    }
  }
  viewChanged() { this.onViewChange({ overview: this.overview, following: this.following }) }
  followPlayer() {
    if (this.zoom < .5) this.zoom = 1
    this.overview = false
    this.following = true
    this.updateCamera(1, true)
    this.viewChanged()
    this.requestDraw()
  }
  screenToMap(p) {
    return { x: this.camera.x + (p.x - this.width / 2) / this.scale,
      y: this.camera.y + (p.y - this.height / 2) / this.scale }
  }
  // Shift the image with the finger. Manual framing persists until explicitly recentered.
  pan(dx, dy) {
    if (this.destroyed) return
    if (this.overview) return
    this.overview = false
    this.following = false
    this.camera = this.limitCamera({ x: this.camera.x - dx / this.scale, y: this.camera.y - dy / this.scale })
    this.viewChanged()
    this.requestDraw()
  }
  zoomAt(factor, from, to) {
    if (this.destroyed || !Number.isFinite(factor) || factor <= 0) return
    from = from || { x: this.width / 2, y: this.height / 2 }
    to = to || from
    const anchor = this.screenToMap(from)
    this.scale = clamp(this.scale * factor, this.minZoom, 1.8)
    this.zoom = this.scale
    this.overview = false
    this.following = false
    this.camera = this.limitCamera({ x: anchor.x - (to.x - this.width / 2) / this.scale,
      y: anchor.y - (to.y - this.height / 2) / this.scale })
    this.viewChanged()
    this.requestDraw()
  }
  toggleOverview() {
    if (this.overview) { this.followPlayer(); return false }
    this.overview = !this.overview
    this.following = false
    this.setInput(0, 0)
    this.updateCamera(1, true)
    this.requestDraw()
    this.viewChanged()
    return this.overview
  }
  setZoom(delta) {
    this.zoomAt(Math.exp(clamp(delta, -10, 10)))
  }
  setMemorials(rows) {
    this.memorials = rows.map(row => ({ ...row, kind: 'memorial' }))
    if (this.destination) this.navigate(this.destination, this.destination.name)
    this.requestDraw()
  }
  navigate(point, name) {
    const route = findRoute(this.player, point, this.memorials)
    if (!route.length) return false
    this.destination = { ...point, name: name || '所选位置' }
    this.route = route.slice(1)
    this._navTime = 0
    this.onNavigation({ active: true, name: this.destination.name, distance: Math.round(this.routeDistance()) })
    return true
  }
  routeDistance() {
    let previous = this.player, total = 0
    this.route.forEach(p => { total += G.distance(previous, p); previous = p })
    return total
  }
  cancelNavigation() { this.route = []; this.destination = null; this.selectedPoint = null; this.onNavigation({ active: false, name: '', distance: 0 }); this.requestDraw() }
  updateNavigation(dt) {
    if (!this.destination || !this.route.length) return
    while (this.route.length && G.distance(this.player, this.route[0]) < 20) this.route.shift()
    if (!this.route.length) {
      const name = this.destination.name
      this.destination = null
      this.onNavigation({ active: false, arrived: true, name, distance: 0 }); return
    }
    this._navTime += dt
    if (this._navTime < .6) return
    this._navTime = 0
    const obstacles = worldIndex.objects.concat(this.memorials)
    if (!clearLine(this.player, this.route[0], obstacles)) {
      const route = findRoute(this.player, this.destination, this.memorials)
      if (route.length) this.route = route.slice(1)
    }
    this.onNavigation({ active: true, name: this.destination.name, distance: Math.round(this.routeDistance()) })
  }
  reset() {
    this.player = Object.assign({}, this.map.spawn)
    this.cancelNavigation()
    this.overview = false
    this.following = true
    this.setInput(0, 0)
    this.direction = 'sw'
    this.walkPhase = this.idleTime = 0
    this.updateCamera(1, true)
    this.requestDraw()
    this.viewChanged()
  }
  path(points) {
    const c = this.ctx
    c.beginPath()
    points.forEach((p, i) => { const q = G.project(p); if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y) })
    c.closePath()
  }
  drawPlayer() {
    const c = this.ctx, p = G.project(this.player), size = 116
    c.fillStyle = 'rgba(42,52,29,0.23)'
    c.beginPath(); c.ellipse(p.x, p.y + 1, 15, 5, 0, 0, Math.PI * 2); c.fill()
    const frame = this.getFrame()
    const img = this.images[this.gender + '/' + (this.moving ? 'walk' : 'idle') + '-' + this.direction + '.png']
    if (img) c.drawImage(img, frame % 4 * 128, Math.floor(frame / 4) * 128, 128, 128,
      p.x - size / 2, p.y - size * 115 / 128, size, size)
  }
  requestDraw() { if (!this.running) this.draw() }
  draw() {
    if (!this.ready || this.destroyed) return
    const c = this.ctx, view = this.viewBounds()
    if (this.chunks && !this.overview) {
      // Full-map rendering uses compact metadata; stream only near the actor at low zoom.
      const streamView = this.scale < .5 ? { left: this.player.x - 380, right: this.player.x + 380, top: this.player.y - 380, bottom: this.player.y + 380 } : view
      const key = [streamView.left, streamView.top, streamView.right, streamView.bottom].map(v => Math.floor(v / layout.CHUNK)).join(':')
      if (key !== this._chunkView) {
        this._chunkView = key
        this.chunks.update(streamView)
        this.objects = this.chunks.objects(); this.cells = this.chunks.cells()
        this.onStreamChange(this.chunks.status())
      }
    }
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.fillStyle = '#e1e7d6'; c.fillRect(0, 0, this.width, this.height)
    c.save(); c.translate(this.width / 2, this.height / 2); c.scale(this.scale, this.scale)
    c.translate(-this.camera.x, -this.camera.y)
    {
      this.ground.draw(c, view, this.images['world-v2/grass.jpg'], this.scale)
      if (this.showGrid) {
        c.lineWidth = 1; c.strokeStyle = 'rgba(255,250,219,.68)'; c.fillStyle = 'rgba(255,244,197,.08)'
        (this.overview ? worldIndex.cells.map(p => ({ id: p.id, corners: layout.rect(p.x - 20, p.y - 16, 40, 32) })) : this.cells).forEach(cell => {
          const p = cell.corners[0]
          if (p.x < view.left - 64 || p.x > view.right || p.y < view.top - 64 || p.y > view.bottom) return
          c.fillStyle = this.occupiedPlots && this.occupiedPlots.has(cell.id) ? '#a18973' : '#d5edab'
          this.path(cell.corners); c.fill(); c.stroke()
        })
      }
      const visible = (this.overview || this.scale < .5 ? worldIndex.objects : this.objects).concat(this.memorials).filter(o => {
        const box = propBox(o)
        return box.x + box.width >= view.left && box.x <= view.right && box.y + box.height >= view.top && box.y <= view.bottom
      })
      // Sort by ground anchor so tree canopies and buildings naturally occlude the character.
      const drawables = visible.map(o => ({ y: o.y, object: o }))
      drawables.push({ y: this.player.y, player: true })
      drawables.sort((a, b) => a.y - b.y).forEach(item => {
        if (item.player) this.drawPlayer()
        else drawProp(c, item.object, this.images['world-v2/props.png'])
      })
      this.drawRoute()
      if (this.overview || this.scale < .5) this.drawMapLabels()
    }
    c.restore()
    if (!this.overview && this.width > 300 && this.height >= 400) this.drawMiniMap()
  }
  drawMapLabels() {
    const c = this.ctx, s = this.scale
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = (11 / s) + 'px sans-serif'
    layout.landmarks.forEach(p => {
      c.fillStyle = '#fffbea'; c.fillRect(p.x - 32 / s, p.y + 12 / s, 64 / s, 17 / s)
      c.fillStyle = '#304e39'; c.fillText(p.name, p.x, p.y + 21 / s)
    })
    c.beginPath(); c.arc(this.player.x, this.player.y, 7 / s, 0, Math.PI * 2)
    c.fillStyle = '#218bd6'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2 / s; c.stroke()
    c.fillStyle = '#fff'; c.fillRect(this.player.x - 74 / s, this.player.y + 8 / s, 64 / s, 19 / s)
    c.fillStyle = '#143c61'; c.textAlign = 'right'; c.fillText('我在这里', this.player.x - 16 / s, this.player.y + 18 / s)
    c.textAlign = 'center'
    if (this.selectedPoint) {
      const p = this.selectedPoint
      c.strokeStyle = '#b66828'; c.lineWidth = 3 / s; c.beginPath(); c.arc(p.x, p.y, 9 / s, 0, Math.PI * 2); c.stroke()
    }
  }
  drawRoute() {
    if (!this.route.length) return
    const c = this.ctx, s = this.scale, p = this.player
    c.beginPath(); c.moveTo(p.x, p.y); this.route.forEach(q => c.lineTo(q.x, q.y))
    c.strokeStyle = '#ffe897'; c.lineWidth = 4 / s; c.stroke()
    const next = this.route[0], angle = Math.atan2(next.y - p.y, next.x - p.x)
    c.save(); c.translate(p.x, p.y); c.rotate(angle); c.translate(48 / s, 0)
    c.beginPath(); c.moveTo(12 / s, 0); c.lineTo(-9 / s, -9 / s); c.lineTo(-4 / s, 0); c.lineTo(-9 / s, 9 / s); c.closePath()
    c.fillStyle = '#ffdf69'; c.fill(); c.strokeStyle = '#5a6236'; c.lineWidth = 1.5 / s; c.stroke(); c.restore()
    const end = this.route[this.route.length - 1]
    c.beginPath(); c.arc(end.x, end.y, 6 / s, 0, Math.PI * 2); c.fillStyle = '#b86838'; c.fill()
  }
  drawMiniMap() {
    const c = this.ctx, w = 104, h = w * G.HEIGHT / G.WIDTH, x = this.width - w - 16, y = 92
    c.save(); c.fillStyle = '#fffbea'; c.fillRect(x - 3, y - 3, w + 6, h + 6)
    c.translate(x, y); c.scale(w / G.WIDTH, h / G.HEIGHT); drawPlan(c); c.restore()
    c.save(); c.strokeStyle = '#fff'; c.lineWidth = 1
    const v = this.viewBounds()
    c.strokeRect(x + v.left / G.WIDTH * w, y + v.top / G.HEIGHT * h,
      (v.right - v.left) / G.WIDTH * w, (v.bottom - v.top) / G.HEIGHT * h)
    c.beginPath(); c.arc(x + this.player.x / G.WIDTH * w, y + this.player.y / G.HEIGHT * h, 3, 0, Math.PI * 2)
    c.fillStyle = '#fff3b9'; c.fill(); c.strokeStyle = '#416247'; c.stroke(); c.restore()
  }
  start() {
    if (this.running || this.destroyed || !this.ready) return
    this.running = true
    this.lastTime = null
    const tick = timestamp => {
      if (!this.running || this.destroyed) return
      const time = Number.isFinite(timestamp) ? timestamp : Date.now()
      const dt = this.lastTime === null ? 0 : (time - this.lastTime) / 1000
      this.lastTime = time
      this.step(dt)
      this.draw()
      this.raf = this.canvas.requestAnimationFrame(tick)
    }
    this.raf = this.canvas.requestAnimationFrame(tick)
  }
  pause() {
    this.running = false
    if (this.raf !== undefined) this.canvas.cancelAnimationFrame(this.raf)
    this.raf = undefined
    this.lastTime = null
    this.setInput(0, 0)
  }
  destroy() {
    this.pause()
    this.destroyed = true
    this.changeVersion++
    this.images = {}
    this.ground.destroy()
    if (this.chunks) this.chunks.destroy()
  }
}
module.exports = { MemorialScene }
