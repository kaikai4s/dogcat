const M = require('./world-template')
function idsFor(view, margin) {
  const result = []
  const x0 = Math.max(0, Math.floor(view.left / M.CHUNK) - margin)
  const y0 = Math.max(0, Math.floor(view.top / M.CHUNK) - margin)
  const x1 = Math.min(M.WIDTH / M.CHUNK - 1, Math.floor(view.right / M.CHUNK) + margin)
  const y1 = Math.min(M.HEIGHT / M.CHUNK - 1, Math.floor(view.bottom / M.CHUNK) + margin)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) result.push(x + '-' + y)
  return result
}
function validateChunk(data, id) {
  const validPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= M.WIDTH && p.y <= M.HEIGHT
  if (!data || data.version !== M.version || data.id !== id || data.cx + '-' + data.cy !== id ||
      !Array.isArray(data.objects) || !Array.isArray(data.cells) || data.objects.length > 200 || data.cells.length > 64 ||
      data.objects.some(o => !M.PROPS[o.kind] || !validPoint(o)) ||
      data.cells.some(c => !Array.isArray(c.corners) || c.corners.length !== 4 || !c.corners.every(validPoint))) {
    throw new Error('园区区域数据不完整，请重新加载')
  }
  return data
}
class ChunkStream {
  constructor(load, onChange) {
    this.load = load; this.onChange = onChange || (() => {})
    this.cache = new Map(); this.pending = new Map(); this.errors = new Map()
    this.wanted = []; this.visible = []; this.maxCache = 40; this.active = 0; this.closed = false
  }
  update(view) {
    if (this.closed) return
    this.visible = idsFor(view, 0)
    const centerX = (view.left + view.right) / 2 / M.CHUNK, centerY = (view.top + view.bottom) / 2 / M.CHUNK
    this.wanted = idsFor(view, 1).sort((a, b) => {
      const distance = id => { const p = id.split('-').map(Number); return Math.hypot(p[0] + .5 - centerX, p[1] + .5 - centerY) }
      return distance(a) - distance(b)
    }).slice(0, this.maxCache)
    for (const id of this.cache.keys()) if (!this.wanted.includes(id)) this.cache.delete(id)
    for (const id of this.errors.keys()) if (!this.wanted.includes(id)) this.errors.delete(id)
    this.pump()
  }
  pump() {
    if (this.closed) return
    for (const id of this.wanted) {
      if (this.active >= 4) break
      if (this.cache.has(id) || this.pending.has(id) || this.errors.has(id)) continue
      this.active++
      const job = Promise.resolve().then(() => this.load(id)).then(data => validateChunk(data, id)).then(data => {
        if (!this.closed && this.wanted.includes(id)) this.cache.set(id, data)
      }).catch(error => {
        if (!this.closed && this.wanted.includes(id)) this.errors.set(id, error)
      }).finally(() => {
        this.active--; this.pending.delete(id)
        if (!this.closed) { this.onChange(); this.pump() }
      })
      this.pending.set(id, job)
    }
  }
  async warm(view) {
    this.update(view)
    while (!this.closed && this.visible.some(id => !this.cache.has(id))) {
      const failed = this.visible.find(id => this.errors.has(id))
      if (failed) throw this.errors.get(failed)
      const jobs = Array.from(this.pending.values())
      if (!jobs.length) break
      await Promise.all(jobs)
    }
  }
  loadedAt(x, y) { return this.cache.has(Math.floor(x / M.CHUNK) + '-' + Math.floor(y / M.CHUNK)) }
  objects() { return Array.from(this.cache.values()).reduce((all, chunk) => all.concat(chunk.objects), []) }
  cells() { return Array.from(this.cache.values()).reduce((all, chunk) => all.concat(chunk.cells), []) }
  status() {
    return { loaded: this.cache.size, failed: this.visible.some(id => this.errors.has(id)),
      loading: this.visible.some(id => !this.cache.has(id) && !this.errors.has(id)) }
  }
  retry() { this.errors.clear(); this.pump() }
  destroy() { this.closed = true; this.cache.clear(); this.errors.clear(); this.wanted = [] }
}
module.exports = { ChunkStream, idsFor, validateChunk }
