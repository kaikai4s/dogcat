const { AssetLoader2D } = require('./asset-loader-2d')
const { createNavigation } = require('./navigation')
const STEP = 56,
  SIZE = 48,
  CHUNK = 112
const clamp = (n, a, b) => Math.max(a, Math.min(b, n))
function yardObstacles(p) {
  const x = p.x,
    z = p.z,
    h = SIZE / 2,
    t = 0.65
  return [
    { minX: x - 9, maxX: x + 9, minZ: z - 8, maxZ: z + 5 },
    { minX: x - h - t, maxX: x - h + t, minZ: z - h, maxZ: z + h },
    { minX: x + h - t, maxX: x + h + t, minZ: z - h, maxZ: z + h },
    { minX: x - h, maxX: x + h, minZ: z - h - t, maxZ: z - h + t },
    { minX: x - h, maxX: x - 3, minZ: z + h - t, maxZ: z + h + t },
    { minX: x + 3, maxX: x + h, minZ: z + h - t, maxZ: z + h + t },
    { minX: x - 3.25, maxX: x - 2.75, minZ: z + h - 3, maxZ: z + h },
    { minX: x + 2.75, maxX: x + 3.25, minZ: z + h - 3, maxZ: z + h },
    { minX: x - 18, maxX: x - 14, minZ: z - 16, maxZ: z - 12 },
    { minX: x + 14, maxX: x + 18, minZ: z - 16, maxZ: z - 12 }
  ]
}
class World2D {
  constructor(page, onStatus, overview, onPetsChange) {
    this.page = page
    this.onStatus = onStatus || (() => {})
    this.onPetsChange = onPetsChange || (() => {})
    this.overviewData = overview || {}
    this.config = { width: 2240, height: 2240, ...this.overviewData.world }
    this.bounds = {
      minX: 0,
      minZ: 0,
      maxX: this.config.width,
      maxZ: this.config.height
    }
    this.ownPlot = this.overviewData.plot
    this.startPoint = {
      x: Math.floor(this.config.width / (STEP * 2)) * STEP,
      z: Math.floor(this.config.height / (STEP * 2)) * STEP
    }
    this.camera = this.ownPlot
      ? { x: this.ownPlot.x, z: this.ownPlot.z + 15 }
      : { ...this.startPoint }
    this.assets = {}
    this.pets = []
    this.chunks = new Map()
    this.pending = new Map()
    this.queue = []
    this.activeLoads = 0
    this.zoom = 1
    this.scale = 4
    this.width = 375
    this.height = 667
    this.follow = true
    this.destroyed = false
    this.placing = false
  }
  async init() {
    const item = await new Promise((resolve, reject) =>
      wx
        .createSelectorQuery()
        .in(this.page)
        .select('#worldCanvas')
        .fields({ node: true, size: true })
        .exec((r) =>
          r && r[0] && r[0].node
            ? resolve(r[0])
            : reject(new Error('无法获取场景画布'))
        )
    )
    if (this.destroyed) return
    this.canvas = item.node
    this.ctx = this.canvas.getContext('2d')
    this.dpr = Math.min(
      (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
        .pixelRatio || 1,
      2
    )
    this.resize(item.width, item.height)
    this.loader = new AssetLoader2D(this.canvas)
    const species = new Set(
      (this.overviewData.pets || []).map((p) =>
        p.species === 'cat' ? 'cat' : 'dog'
      )
    )
    const initialAssets = [
      'grass_tile',
      ...[...species].flatMap((s) => [s + '_stand', s + '_run'])
    ]
    this.assets = await this.loader.loadAll(
      (p) => this.onStatus('加载云端素材 ' + p + '%…'),
      initialAssets
    )
    if (this.destroyed) return
    this.pattern = this.ctx.createPattern(this.assets.grass_tile, 'repeat')
    this.buildWorld()
    await this.loadVisible()
    if (this.destroyed) return
    this.onStatus(
      this.ownPlot ? '点击草地让宠物行走' : '先浏览草地，为自己的家选一个位置'
    )
    this.start()
  }
  resize(w, h) {
    this.width = w
    this.height = h
    if (this.canvas) {
      this.canvas.width = Math.round(w * this.dpr)
      this.canvas.height = Math.round(h * this.dpr)
    }
  }
  buildWorld() {
    const origin = this.ownPlot
      ? { x: this.ownPlot.x, z: this.ownPlot.z + 14 }
      : this.camera
    this.pets = (this.overviewData.pets || []).slice(0, 8).map((p, i) => ({
      id: p._id,
      name: p.name || '宠物',
      species: p.species,
      position: {
        x: origin.x + (i % 3) * 2,
        z: origin.z + (this.ownPlot ? Math.floor(i / 3) * 2 : 0)
      },
      route: [],
      moving: false
    }))
    this.selectedPetId = this.pets[0] && this.pets[0].id
    this.emitPets()
  }
  emitPets() {
    this.onPetsChange(
      this.pets.map((p) => ({
        id: p.id,
        name: p.name,
        species: p.species,
        selected: p.id === this.selectedPetId,
        available: true,
        status: p.moving ? '行走中' : '等待指令'
      }))
    )
  }
  selectedPet() {
    return this.pets.find((p) => p.id === this.selectedPetId)
  }
  selectPet(id) {
    if (!this.pets.some((p) => p.id === id)) return false
    this.selectedPetId = id
    this.emitPets()
    return true
  }
  project(x, z) {
    const s = this.scale * this.zoom,
      dx = x - this.camera.x,
      dz = z - this.camera.z
    return {
      x: this.width / 2 + (dx - dz) * s,
      y: this.height * 0.48 + (dx + dz) * s * 0.52
    }
  }
  unproject(x, y) {
    const s = this.scale * this.zoom,
      a = (x - this.width / 2) / s,
      b = (y - this.height * 0.48) / (s * 0.52)
    return { x: this.camera.x + (a + b) / 2, z: this.camera.z + (b - a) / 2 }
  }
  visibleBounds(margin = 32) {
    const pts = [
      [0, 0],
      [this.width, 0],
      [0, this.height],
      [this.width, this.height]
    ].map((p) => this.unproject(...p))
    return {
      minX: clamp(
        Math.min(...pts.map((p) => p.x)) - margin,
        0,
        this.config.width
      ),
      maxX: clamp(
        Math.max(...pts.map((p) => p.x)) + margin,
        0,
        this.config.width
      ),
      minZ: clamp(
        Math.min(...pts.map((p) => p.z)) - margin,
        0,
        this.config.height
      ),
      maxZ: clamp(
        Math.max(...pts.map((p) => p.z)) + margin,
        0,
        this.config.height
      )
    }
  }
  chunkKey(x, z) {
    return x + ',' + z
  }
  loadChunk(x, z) {
    const key = this.chunkKey(x, z)
    if (
      x < 0 ||
      z < 0 ||
      x * CHUNK >= this.config.width ||
      z * CHUNK >= this.config.height
    )
      return Promise.resolve()
    if (this.chunks.has(key)) return Promise.resolve(this.chunks.get(key))
    if (this.pending.has(key)) return this.pending.get(key)
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ x, z, key, resolve, reject })
      this.pump()
    })
    this.pending.set(key, promise)
    return promise
  }
  pump() {
    while (!this.destroyed && this.activeLoads < 4 && this.queue.length) {
      const task = this.queue.shift()
      this.activeLoads++
      Promise.resolve()
        .then(() => this.page.fetchRegion(task.x, task.z))
        .then((r) => {
          if (!this.destroyed) this.chunks.set(task.key, r.plots || [])
          task.resolve(r)
        })
        .catch(task.reject)
        .finally(() => {
          this.pending.delete(task.key)
          this.activeLoads--
          this.pump()
        })
    }
  }
  async loadArea(b) {
    const tasks = []
    for (
      let x = Math.floor(b.minX / CHUNK);
      x <= Math.floor(b.maxX / CHUNK);
      x++
    )
      for (
        let z = Math.floor(b.minZ / CHUNK);
        z <= Math.floor(b.maxZ / CHUNK);
        z++
      )
        tasks.push(this.loadChunk(x, z))
    await Promise.all(tasks)
  }
  async loadVisible() {
    await this.loadArea(this.visibleBounds())
    if (this.destroyed) return
    if (this.plots().length && this.loader) await this.loadYardAssets()
    const b = this.visibleBounds(CHUNK)
    for (const [k] of this.chunks) {
      const [x, z] = k.split(',').map(Number)
      if (
        (x + 1) * CHUNK < b.minX ||
        x * CHUNK > b.maxX ||
        (z + 1) * CHUNK < b.minZ ||
        z * CHUNK > b.maxZ
      )
        this.chunks.delete(k)
    }
  }
  async loadYardAssets() {
    if (!this.yardAssetsPromise) {
      this.yardAssetsPromise = this.loader
        .loadAll(null, [
          'house',
          'tree',
          'flower_bush',
          'street_lamp',
          'stone_tile',
          'road_tile'
        ])
        .then((assets) => {
          if (!this.destroyed) Object.assign(this.assets, assets)
        })
        .catch((error) => {
          this.yardAssetsPromise = null
          throw error
        })
    }
    return this.yardAssetsPromise
  }
  plots() {
    const map = new Map()
    for (const rows of this.chunks.values())
      for (const p of rows) map.set(p.id, p)
    if (this.ownPlot) map.set(this.ownPlot.id, this.ownPlot)
    return [...map.values()]
  }
  obstacles() {
    return this.plots().flatMap(yardObstacles)
  }
  async moveTo(target) {
    const pet = this.selectedPet()
    if (!pet) return this.onStatus('请先添加宠物档案')
    if (
      target.x < 1 ||
      target.z < 1 ||
      target.x > this.config.width - 1 ||
      target.z > this.config.height - 1
    )
      return this.onStatus('不能走出场景边界')
    const token = (this.moveToken = (this.moveToken || 0) + 1)
    const p = pet.position,
      b = {
        minX: clamp(Math.min(p.x, target.x) - 30, 0, this.config.width),
        maxX: clamp(Math.max(p.x, target.x) + 30, 0, this.config.width),
        minZ: clamp(Math.min(p.z, target.z) - 30, 0, this.config.height),
        maxZ: clamp(Math.max(p.z, target.z) + 30, 0, this.config.height)
      }
    if (b.maxX - b.minX > 400 || b.maxZ - b.minZ > 400)
      return this.onStatus('请先选择附近的草地，逐步前往远处')
    try {
      await this.loadArea(b)
      if (this.destroyed || token !== this.moveToken) return
      const nav = createNavigation(b, this.obstacles(), 0.8, 1.5)
      if (!nav.walkable(target))
        return this.onStatus('这里有房屋或栅栏，请选择空地')
      const route = nav.path(p, target)
      if (!route) return this.onStatus('暂时无法到达，请从院门进出')
      pet.route = route
      pet.moving = route.length > 0
      this.follow = true
      this.emitPets()
      this.onStatus('宠物前往选定位置 · 通过院门进出庭院')
    } catch (e) {
      this.onStatus('附近场景加载失败，请重新点击草地')
    }
  }
  request(action) {
    const p = this.ownPlot
    if (!p) return false
    const offsets = { eat: [-10, 12], drink: [10, 12], sleep: [0, 10] }
    const d = offsets[action]
    if (!d) return false
    this.moveTo({ x: p.x + d[0], z: p.z + d[1] })
    return true
  }
  overview() {
    this.follow = false
    this.camera = this.ownPlot
      ? { x: this.ownPlot.x, z: this.ownPlot.z }
      : { ...this.startPoint }
    this.zoom = 1
    this.loadVisible().catch(() => this.onStatus('场景加载失败，请稍后重试'))
  }
  followPet() {
    this.follow = true
    const p = this.selectedPet()
    if (p) this.camera = { ...p.position }
  }
  beginPlacement() {
    if (this.ownPlot) return
    this.placing = true
    this.candidate = null
    this.follow = false
    this.onStatus('点击空草坪预览庭院，再确认永久位置')
    this.page.setData({ placing: true, canConfirm: false })
  }
  cancelPlacement() {
    this.placing = false
    this.candidate = null
    this.page.setData({ placing: false, canConfirm: false })
  }
  async pickPlot(point) {
    this.candidate = null
    this.page.setData({ canConfirm: false })
    const token = (this.pickToken = (this.pickToken || 0) + 1)
    const x = Math.floor(point.x / STEP),
      z = Math.floor(point.z / STEP)
    if (
      x < 0 ||
      z < 0 ||
      (x + 1) * STEP > this.config.width ||
      (z + 1) * STEP > this.config.height
    )
      return this.onStatus('请在场景范围内选择')
    try {
      await this.loadChunk(Math.floor(x / 2), Math.floor(z / 2))
      if (this.destroyed || !this.placing || token !== this.pickToken) return
      if (this.plots().some((p) => p.cellX === x && p.cellZ === z))
        return this.onStatus('这里已有房屋，请选择空草坪')
      this.candidate = {
        cellX: x,
        cellZ: z,
        x: x * STEP + STEP / 2,
        z: z * STEP + STEP / 2,
        size: SIZE
      }
      this.page.setData({ canConfirm: true })
      this.onStatus('绿色区域为庭院范围 · 确认后永久保留，不能移动')
    } catch (e) {
      this.onStatus('位置读取失败，请重新选择')
    }
  }
  setPlot(plot) {
    this.ownPlot = plot
    this.cancelPlacement()
    this.camera = { x: plot.x, z: plot.z + 15 }
    this.pets.forEach((p, i) => {
      p.position = {
        x: plot.x + (i % 3) * 2,
        z: plot.z + 14 + Math.floor(i / 3) * 2
      }
      p.route = []
      p.moving = false
    })
    this.emitPets()
    this.onStatus('房屋位置已永久保存')
    this.loadVisible().catch(() =>
      this.onStatus('房屋已保存，庭院素材加载失败，请重新进入')
    )
  }
  line(a, b, color, width) {
    const c = this.ctx
    c.beginPath()
    c.moveTo(a.x, a.y)
    c.lineTo(b.x, b.y)
    c.strokeStyle = color
    c.lineWidth = width
    c.stroke()
  }
  diamond(x, z, h, fill) {
    const c = this.ctx,
      pts = [
        [x - h, z - h],
        [x + h, z - h],
        [x + h, z + h],
        [x - h, z + h]
      ].map((p) => this.project(...p))
    c.beginPath()
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)))
    c.closePath()
    c.fillStyle = fill
    c.fill()
  }
  fenceSegment(a, b, items) {
    const n = Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / 3)
    for (let i = 0; i < n; i++) {
      const p = {
          x: a.x + ((b.x - a.x) * i) / n,
          z: a.z + ((b.z - a.z) * i) / n
        },
        q = {
          x: a.x + ((b.x - a.x) * (i + 1)) / n,
          z: a.z + ((b.z - a.z) * (i + 1)) / n
        }
      items.push({
        depth: (p.x + q.x + p.z + q.z) / 2,
        draw: () => {
          const s = this.scale * this.zoom,
            A = this.project(p.x, p.z),
            B = this.project(q.x, q.z)
          this.line(A, { x: A.x, y: A.y - 2.5 * s }, '#795638', 1.1 * s)
          for (const h of [1, 2])
            this.line(
              { x: A.x, y: A.y - h * s },
              { x: B.x, y: B.y - h * s },
              '#e5c79a',
              0.65 * s
            )
          this.line(
            { x: A.x, y: A.y - 2.5 * s },
            { x: A.x, y: A.y - 2.7 * s },
            '#f6e5bf',
            1.25 * s
          )
        }
      })
    }
  }
  sprite(name, x, z, size, anchor = 0.86) {
    const img = this.assets[name]
    if (!img) return
    const p = this.project(x, z),
      w = size * this.scale * this.zoom
    if (
      p.x + w < 0 ||
      p.x - w > this.width ||
      p.y + w < 0 ||
      p.y - w > this.height
    )
      return
    this.ctx.drawImage(img, p.x - w / 2, p.y - w * anchor, w, w)
  }
  draw() {
    const c = this.ctx
    if (!c) return
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.fillStyle = '#dce8cf'
    c.fillRect(0, 0, this.width, this.height)
    const s = this.scale * this.zoom,
      o = this.project(0, 0)
    c.save()
    c.transform(s, s * 0.52, -s, s * 0.52, o.x, o.y)
    c.scale(1 / 16, 1 / 16)
    c.fillStyle = this.pattern || '#7eb05b'
    const ground = this.visibleBounds(0)
    c.fillRect(
      ground.minX * 16,
      ground.minZ * 16,
      (ground.maxX - ground.minX) * 16,
      (ground.maxZ - ground.minZ) * 16
    )
    c.restore()
    const b = this.visibleBounds(50),
      items = []
    for (const p of this.plots()) {
      if (
        p.x + 24 < b.minX ||
        p.x - 24 > b.maxX ||
        p.z + 24 < b.minZ ||
        p.z - 24 > b.maxZ
      )
        continue
      // A stone path leads from the central villa to the six-metre gate.
      for (let z = 8; z <= 20; z += 3)
        this.sprite('stone_tile', p.x, p.z + z, 6, 0.5)
      this.sprite('road_tile', p.x, p.z + 21, 7, 0.5)
      const sprites = [
        ['house', 0, 0, 38],
        ['tree', -16, -14, 14],
        ['tree', 16, -14, 14],
        ['flower_bush', -17, 14, 7],
        ['flower_bush', 17, 14, 7],
        ['street_lamp', 8, 20, 9]
      ]
      for (const [name, x, z, size] of sprites)
        items.push({
          depth: p.x + x + p.z + z,
          draw: () => this.sprite(name, p.x + x, p.z + z, size)
        })
      const x = p.x,
        z = p.z,
        h = 24
      this.fenceSegment({ x: x - h, z: z - h }, { x: x + h, z: z - h }, items)
      this.fenceSegment({ x: x - h, z: z - h }, { x: x - h, z: z + h }, items)
      this.fenceSegment({ x: x + h, z: z - h }, { x: x + h, z: z + h }, items)
      this.fenceSegment({ x: x - h, z: z + h }, { x: x - 3, z: z + h }, items)
      this.fenceSegment({ x: x + 3, z: z + h }, { x: x + h, z: z + h }, items)
      // Gate leaves remain open beside the entrance.
      this.fenceSegment(
        { x: x - 3, z: z + h },
        { x: x - 3, z: z + h - 3 },
        items
      )
      this.fenceSegment(
        { x: x + 3, z: z + h },
        { x: x + 3, z: z + h - 3 },
        items
      )
    }
    for (const p of this.pets)
      items.push({
        depth: p.position.x + p.position.z,
        draw: () => {
          this.sprite(
            (p.species === 'cat' ? 'cat' : 'dog') +
              (p.moving ? '_run' : '_stand'),
            p.position.x,
            p.position.z,
            7
          )
          if (p.id === this.selectedPetId) {
            const pt = this.project(p.position.x, p.position.z)
            c.fillStyle = '#fffdf0'
            c.font = '12px sans-serif'
            c.textAlign = 'center'
            c.fillText(p.name, pt.x, pt.y - 7 * s)
          }
        }
      })
    items.sort((a, b) => a.depth - b.depth).forEach((i) => i.draw())
    if (this.candidate)
      this.diamond(
        this.candidate.x,
        this.candidate.z,
        24,
        'rgba(82,192,103,.38)'
      )
  }
  update(dt) {
    for (const pet of this.pets) {
      let budget = dt * 7
      pet.moving = pet.route.length > 0
      while (budget > 0 && pet.route.length) {
        const t = pet.route[0],
          p = pet.position,
          d = Math.hypot(t.x - p.x, t.z - p.z)
        if (d < 0.001) {
          pet.route.shift()
          continue
        }
        const n = Math.min(d, budget)
        p.x = clamp(p.x + ((t.x - p.x) * n) / d, 1, this.config.width - 1)
        p.z = clamp(p.z + ((t.z - p.z) * n) / d, 1, this.config.height - 1)
        budget -= n
        if (n === d) pet.route.shift()
      }
      if (pet.moving && !pet.route.length) {
        pet.moving = false
        this.emitPets()
        this.onStatus('已到达 · 点击草地继续行走')
      }
    }
    const pet = this.selectedPet()
    if (this.follow && pet) this.camera = { ...pet.position }
  }
  start() {
    const tick = (t) => {
      if (this.destroyed) return
      const dt =
        this.lastFrame === undefined
          ? 0
          : Math.min(0.05, Math.max(0, (t - this.lastFrame) / 1000))
      this.lastFrame = t
      this.update(dt)
      this.draw()
      if (!this.lastLoad || t - this.lastLoad > 600) {
        this.lastLoad = t
        this.loadVisible().catch(() =>
          this.onStatus('附近场景加载失败，正在重试')
        )
      }
      this.frame = this.canvas.requestAnimationFrame(tick)
    }
    this.frame = this.canvas.requestAnimationFrame(tick)
  }
  touchStart(touches) {
    if (!touches.length) return
    const a = touches[0],
      x = a.x === undefined ? a.clientX : a.x,
      y = a.y === undefined ? a.clientY : a.y
    this.gesture = {
      x,
      y,
      lastX: x,
      lastY: y,
      moved: false,
      camera: { ...this.camera },
      zoom: this.zoom
    }
    if (touches.length > 1) {
      const b = touches[1]
      this.gesture.distance = Math.hypot(
        x - (b.x === undefined ? b.clientX : b.x),
        y - (b.y === undefined ? b.clientY : b.y)
      )
      this.gesture.moved = true
    }
  }
  touchMove(touches) {
    const g = this.gesture
    if (!g || !touches.length) return
    const a = touches[0],
      x = a.x === undefined ? a.clientX : a.x,
      y = a.y === undefined ? a.clientY : a.y
    if (Math.hypot(x - g.x, y - g.y) > 6) g.moved = true
    if (touches.length > 1) {
      const b = touches[1],
        d = Math.hypot(
          x - (b.x === undefined ? b.clientX : b.x),
          y - (b.y === undefined ? b.clientY : b.y)
        )
      if (g.distance) this.zoom = clamp((g.zoom * d) / g.distance, 0.65, 2.5)
      else {
        g.distance = d
        g.zoom = this.zoom
      }
      g.moved = true
    } else if (g.moved) {
      const s = this.scale * this.zoom,
        dx = (x - g.lastX) / s,
        dy = (y - g.lastY) / (s * 0.52)
      this.camera.x = clamp(this.camera.x - (dx + dy) / 2, 0, this.config.width)
      this.camera.z = clamp(
        this.camera.z - (dy - dx) / 2,
        0,
        this.config.height
      )
    }
    this.follow = false
    g.lastX = x
    g.lastY = y
  }
  touchEnd() {
    const g = this.gesture
    this.gesture = null
    if (g && !g.moved) {
      const p = this.unproject(g.x, g.y)
      if (this.placing) this.pickPlot(p)
      else this.moveTo(p)
    }
  }
  destroy() {
    this.destroyed = true
    this.moveToken = (this.moveToken || 0) + 1
    if (this.canvas && this.frame !== undefined)
      this.canvas.cancelAnimationFrame(this.frame)
    for (const t of this.queue) t.resolve()
    this.queue = []
    this.chunks.clear()
    this.assets = {}
  }
}
module.exports = { World2D, yardObstacles, STEP, SIZE, CHUNK }
