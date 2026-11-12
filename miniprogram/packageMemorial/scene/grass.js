const M = require('./world-template')
const world = require('./world-index')
const { hash, smooth } = require('./environment')
const { wideView } = require('./ground-cache')
const TILE = 384, STEP = 24, BIN = 48
const MAX_TILES = 40, MAX_TUFTS = 1200, MAX_IMPULSES = 2400
const BEND_STEP = .6, BENDS = 51, VARIANTS = 8, SPRITE_W = 64, SPRITE_H = 24, COLUMNS = 16
const BLADES = Array.from({ length: VARIANTS }, (_, variant) => Array.from({ length: 6 }, (_, i) => {
  const seed = 'grass-blade:' + variant + ':' + i
  return { x: (hash(seed) - .5) * 12, y: (hash(seed + 'y') - .5) * 4,
    height: 6 + hash(seed + 'h') * 8, lean: (i / 5 - .5) * 11 + (hash(seed + 'l') - .5) * 3,
    width: .65 + hash(seed + 'w') * .65, shade: i % 3 }
}))
const PALETTES = {
  spring: [[72, 103, 43], [114, 146, 68], [164, 184, 105]],
  summer: [[65, 91, 38], [105, 133, 59], [154, 173, 88]],
  autumn: [[92, 103, 45], [139, 145, 73], [187, 182, 108]],
  winter: [[108, 124, 98], [155, 169, 140], [204, 214, 188]]
}
const inView = (p, v, pad = 20) => p.x >= v.left - pad && p.x <= v.right + pad && p.y >= v.top - pad && p.y <= v.bottom + pad
const key = (x, y, size) => Math.floor(x / size) + ':' + Math.floor(y / size)
function grassGround(x, y) {
  return x >= 84 && y >= 84 && x <= M.WIDTH - 84 && y <= M.HEIGHT - 84 && !M.onRoad(x, y, 14)
}
function maskIndex(objects) {
  const bins = new Map()
  for (const o of objects) {
    const r = o.kind === 'memorial' ? 80 : M.PROPS[o.kind].radius + 24
    for (let y = Math.floor((o.y - r) / TILE); y <= Math.floor((o.y + r) / TILE); y++) {
      for (let x = Math.floor((o.x - r) / TILE); x <= Math.floor((o.x + r) / TILE); x++) {
        const id = x + ':' + y
        if (!bins.has(id)) bins.set(id, [])
        bins.get(id).push(o)
      }
    }
  }
  return bins
}
function covered(p, objects) {
  return objects.some(o => o.kind === 'memorial'
    ? Math.abs(p.x - o.x) < (o.legacy ? 40 : 66) && p.y > o.y - 40 && p.y < o.y + (o.legacy ? 32 : 56)
    : Math.hypot(p.x - o.x, (p.y - o.y) * 1.35) < M.PROPS[o.kind].radius + 11)
}
// World-space roots are deterministic. Only nearby visible blades are drawn;
// movement comes from the existing local/interpolated visitors, with no new network traffic.
class GrassRenderer {
  constructor(createCanvas) {
    this.tiles = new Map(); this.impulses = new Map(); this.previous = new Map()
    this.staticMasks = maskIndex(world.objects); this.memorialMasks = new Map()
    this.visible = []; this.front = new Map(); this.time = 0
    this.createCanvas = createCanvas; this.atlas = null; this.sprites = new Set()
  }
  advance(dt) { this.time += Math.max(0, Math.min(.05, Number.isFinite(dt) ? dt : 0)) }
  setMemorials(rows) { this.memorialMasks = maskIndex(rows) }
  tile(cx, cy) {
    const id = cx + ':' + cy
    if (this.tiles.has(id)) { const points = this.tiles.get(id); this.tiles.delete(id); this.tiles.set(id, points); return points }
    const points = [], masks = this.staticMasks.get(id) || []
    for (let row = cy * TILE / STEP; row < (cy + 1) * TILE / STEP; row++) {
      for (let col = cx * TILE / STEP; col < (cx + 1) * TILE / STEP; col++) {
        const seed = 'grass-v1:' + row + ':' + col
        const x = col * STEP + 12 + (hash(seed) - .5) * 17, y = row * STEP + 12 + (hash(seed + 'y') - .5) * 17
        const p = { id: row * (M.WIDTH / STEP) + col, x, y, phase: hash(seed + 'phase') * Math.PI * 2 }
        if (!grassGround(x, y) || covered(p, masks)) continue
        p.variant = Math.floor(hash(seed + 'variant') * VARIANTS)
        p.blades = BLADES[p.variant]
        points.push(p)
      }
    }
    this.tiles.set(id, points)
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value)
    return points
  }
  recovery(p) {
    const impulse = this.impulses.get(p.id)
    if (!impulse) return { bend: 0, press: 0 }
    const age = Math.max(0, this.time - impulse.time)
    return { bend: impulse.bend * Math.exp(-age * 2.5) * Math.cos(age * 3.5), press: impulse.press * Math.exp(-age * 3) }
  }
  footprints(scene, view) {
    const bins = new Map(), previous = new Map()
    const actors = [{ id: 'local', ...scene.player }, ...scene.visitors.actors.values()]
    for (const actor of actors) {
      if (!inView(actor, view, 64)) continue
      const before = this.previous.get(actor.id)
      // Teleports, reconnects and changing maps never sweep across the garden.
      const a = before && before.epoch === actor.epoch && Math.hypot(actor.x - before.x, actor.y - before.y) < 32 ? before : actor
      previous.set(actor.id, { x: actor.x, y: actor.y, epoch: actor.epoch })
      const footprint = { x: actor.x, y: actor.y + 2, ax: a.x, ay: a.y + 2 }
      for (let y = Math.floor((Math.min(a.y, actor.y) - 24) / BIN); y <= Math.floor((Math.max(a.y, actor.y) + 26) / BIN); y++) {
        for (let x = Math.floor((Math.min(a.x, actor.x) - 30) / BIN); x <= Math.floor((Math.max(a.x, actor.x) + 30) / BIN); x++) {
          const id = x + ':' + y
          if (!bins.has(id)) bins.set(id, [])
          bins.get(id).push(footprint)
        }
      }
    }
    this.previous = previous
    return bins
  }
  contact(p, footprints) {
    let press = 0, bend = 0
    for (const f of footprints) {
      const vx = f.x - f.ax, vy = f.y - f.ay
      const along = Math.max(0, Math.min(1, ((p.x - f.ax) * vx + (p.y - f.ay) * vy) / (vx * vx + vy * vy || 1)))
      const dx = p.x - (f.ax + vx * along), dy = p.y - (f.ay + vy * along)
      const distance = Math.hypot(dx / 29, dy / 21)
      if (distance >= 1) continue
      const amount = smooth(1 - distance)
      if (amount > press) { press = amount; bend = Math.max(-12, Math.min(12, dx / 18 * 16 + vx * .8)) * amount }
    }
    const old = this.recovery(p)
    if (press > old.press) {
      const value = { time: this.time, press, bend }
      this.impulses.delete(p.id); this.impulses.set(p.id, value)
      return value
    }
    return old
  }
  prepare(scene, view, env, timeMs = env.time) {
    this.visible = []; this.front.clear()
    for (const [id, impulse] of this.impulses) if (this.time - impulse.time > 2.4) this.impulses.delete(id)
    if (scene.overview || wideView(view, scene.scale) || scene.scale < .6) { this.resetMotion(); return }
    const footprints = this.footprints(scene, view)
    const stride = Math.max(1, Math.ceil(((view.right - view.left) / STEP + 4) * ((view.bottom - view.top) / STEP + 4) / MAX_TUFTS))
    this.alpha = smooth((scene.scale - .6) / .3)
    this.colors = [0, 1, 2].map(shade => 'rgb(' + [0, 1, 2].map(channel => Math.round(Object.keys(PALETTES).reduce((n, season) => n + PALETTES[season][shade][channel] * env.seasons[season], 0))).join(',') + ')')
    const time = timeMs / 1000, wind = env.weather.wind
    for (let y = Math.max(0, Math.floor((view.top - 20) / TILE)); y <= Math.min(M.HEIGHT / TILE - 1, Math.floor((view.bottom + 20) / TILE)); y++) {
      for (let x = Math.max(0, Math.floor((view.left - 20) / TILE)); x <= Math.min(M.WIDTH / TILE - 1, Math.floor((view.right + 20) / TILE)); x++) {
        const masks = this.memorialMasks.get(x + ':' + y) || []
        for (const p of this.tile(x, y)) {
          if (!inView(p, view) || p.id % stride || covered(p, masks) || this.visible.length >= MAX_TUFTS) continue
          const reaction = this.contact(p, footprints.get(key(p.x, p.y, BIN)) || [])
          const sway = scene.effectsEnabled ? Math.sin(time * 1.7 + p.x * .022 + p.y * .013) * 1.3 + Math.sin(time * .8 + p.phase) * .5 + wind * .8 : 0
          const item = { p, bend: sway * (1 - reaction.press) + reaction.bend, press: reaction.press,
            height: 1 - env.seasons.winter * .15 }
          this.visible.push(item)
          const id = key(p.x, p.y, BIN)
          if (!this.front.has(id)) this.front.set(id, [])
          this.front.get(id).push(item)
        }
      }
    }
    while (this.impulses.size > MAX_IMPULSES) this.impulses.delete(this.impulses.keys().next().value)
  }
  draw(c, items = this.visible) {
    if (!items.length) return
    if (this.createCanvas) {
      try {
        if (!this.atlas) this.atlas = this.createCanvas(COLUMNS * SPRITE_W, Math.ceil(BENDS * VARIANTS / COLUMNS) * SPRITE_H)
        const palette = this.colors.join(':')
        if (palette !== this.palette) {
          this.atlas.getContext('2d').clearRect(0, 0, this.atlas.width, this.atlas.height)
          this.sprites.clear(); this.palette = palette
        }
      } catch (_) { this.atlas = null; this.createCanvas = null }
    }
    if (!this.atlas) { this.drawPaths(c, items, this.alpha); return }
    c.save(); c.globalAlpha = this.alpha
    for (const item of items) {
      // Subpixel bend steps retain a rooted silhouette. Compression scales from
      // that same root, so footsteps don't make the whole tuft slide or hop.
      const bend = Math.max(0, Math.min(BENDS - 1, Math.round(item.bend / BEND_STEP) + 25))
      const id = item.p.variant * BENDS + bend
      const sx = id % COLUMNS * SPRITE_W, sy = Math.floor(id / COLUMNS) * SPRITE_H
      if (!this.sprites.has(id)) {
        this.drawPaths(this.atlas.getContext('2d'), [{ p: { ...item.p, x: sx + 32, y: sy + 20 }, bend: (bend - 25) * BEND_STEP, press: 0, height: 1 }], 1)
        this.sprites.add(id)
      }
      const scaleY = item.height * (1 - item.press * .64)
      c.drawImage(this.atlas, sx, sy, SPRITE_W, SPRITE_H, item.p.x - 32, item.p.y - 20 * scaleY, SPRITE_W, SPRITE_H * scaleY)
    }
    c.restore()
  }
  drawPaths(c, items, alpha) {
    c.save()
    // Also serves as the fallback for devices without an offscreen canvas.
    for (let shade = 0; shade < 3; shade++) {
      c.fillStyle = this.colors[shade]; c.globalAlpha = alpha * [.52, .74, .65][shade]; c.beginPath()
      for (const item of items) for (const blade of item.p.blades) {
        if (blade.shade !== shade) continue
        const x = item.p.x + blade.x, y = item.p.y + blade.y
        const h = blade.height * item.height * (1 - item.press * .64)
        const lean = blade.lean + item.bend, tip = x + lean
        c.moveTo(x - blade.width, y)
        c.quadraticCurveTo(x + lean * .22 - blade.width, y - h * .65, tip, y - h)
        c.quadraticCurveTo(x + lean * .48 + blade.width, y - h * .45, x + blade.width, y)
        c.closePath()
      }
      c.fill()
    }
    c.restore()
  }
  feet(c, actor) {
    if (!this.visible.length) return
    const items = []
    for (let y = Math.floor((actor.y - 1) / BIN); y <= Math.floor((actor.y + 9) / BIN); y++) {
      for (let x = Math.floor((actor.x - 18) / BIN); x <= Math.floor((actor.x + 18) / BIN); x++) {
        for (const item of this.front.get(x + ':' + y) || []) {
          if (Math.abs(item.p.x - actor.x) <= 18 && item.p.y >= actor.y - 1 && item.p.y <= actor.y + 9) items.push(item)
        }
      }
    }
    if (!items.length) return
    c.save(); c.beginPath(); c.rect(actor.x - 18, actor.y - 9, 36, 18); c.clip()
    this.draw(c, items); c.restore()
  }
  resetMotion() { this.impulses.clear(); this.previous.clear() }
  destroy() { this.resetMotion(); this.tiles.clear(); this.visible = []; this.front.clear(); this.memorialMasks.clear(); this.atlas = null; this.sprites.clear() }
}
module.exports = { GrassRenderer, grassGround, covered, TILE, STEP, MAX_TILES, MAX_TUFTS, MAX_IMPULSES }
