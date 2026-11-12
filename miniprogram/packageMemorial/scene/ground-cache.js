const { drawGround } = require('./terrain')
const M = require('./world-template')
function wideView(view, scale) {
  const cols = Math.max(0, Math.min(M.WIDTH / M.CHUNK, Math.ceil(view.right / M.CHUNK)) - Math.max(0, Math.floor(view.left / M.CHUNK)))
  const rows = Math.max(0, Math.min(M.HEIGHT / M.CHUNK, Math.ceil(view.bottom / M.CHUNK)) - Math.max(0, Math.floor(view.top / M.CHUNK)))
  return scale < .5 || cols * rows > 24
}
// Render expensive paving once into bounded native offscreen tiles.
class GroundCache {
  constructor(createCanvas) { this.createCanvas = createCanvas; this.tiles = new Map(); this.overview = null }
  draw(c, view, grass, scale) {
    if (!this.createCanvas) { drawGround(c, view, grass); return }
    try {
      if (wideView(view, scale)) {
        if (!this.overview) {
          const ratio = Math.min(1536 / M.WIDTH, 1152 / M.HEIGHT)
          const canvas = this.createCanvas(Math.ceil(M.WIDTH * ratio), Math.ceil(M.HEIGHT * ratio)), ctx = canvas.getContext('2d')
          ctx.scale(ratio, ratio); drawGround(ctx, { left: 0, top: 0, right: M.WIDTH, bottom: M.HEIGHT }, grass)
          this.overview = canvas
        }
        c.drawImage(this.overview, 0, 0, M.WIDTH, M.HEIGHT); return
      }
      const size = 384, wanted = new Set()
      for (let y = Math.max(0, Math.floor(view.top / size)); y < Math.min(Math.ceil(M.HEIGHT / size), Math.ceil(view.bottom / size)); y++) {
        for (let x = Math.max(0, Math.floor(view.left / size)); x < Math.min(Math.ceil(M.WIDTH / size), Math.ceil(view.right / size)); x++) {
          const key = x + '-' + y; wanted.add(key)
          if (!this.tiles.has(key)) {
            const canvas = this.createCanvas(size, size), ctx = canvas.getContext('2d')
            ctx.translate(-x * size, -y * size)
            drawGround(ctx, { left: x * size, top: y * size, right: (x + 1) * size, bottom: (y + 1) * size }, grass)
            this.tiles.set(key, canvas)
          }
          c.drawImage(this.tiles.get(key), x * size, y * size, size, size)
        }
      }
      for (const key of this.tiles.keys()) if (this.tiles.size > 24 && !wanted.has(key)) this.tiles.delete(key)
    } catch (_) {
      this.destroy(); this.createCanvas = null; drawGround(c, view, grass)
    }
  }
  destroy() { this.tiles.clear(); this.overview = null }
}
module.exports = { GroundCache, wideView }
