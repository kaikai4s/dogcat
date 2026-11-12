// Per-scene cache. Decode only visible portraits, with bounded memory/concurrency.
class PortraitImages {
  constructor(load, changed, failed, now = Date.now) {
    this.load = load; this.changed = changed; this.failed = failed; this.now = now
    this.items = new Map(); this.active = 0; this.destroyed = false
  }
  get(asset) {
    if (this.destroyed || !asset || !asset.id || !asset.url) return null
    let item = this.items.get(asset.id)
    if (item) { this.items.delete(asset.id); this.items.set(asset.id, item) }
    if (item && item.image) return item.image
    if (item && item.loading || this.active >= 4) return null
    if (item && item.url === asset.url && item.retryAt > this.now()) return null
    if (!item) {
      if (this.items.size >= 24) {
        const oldest = [...this.items].find(([, entry]) => !entry.loading)
        if (!oldest) return null
        this.items.delete(oldest[0])
      }
      item = {}; this.items.set(asset.id, item)
    }
    item.url = asset.url; item.loading = true; this.active++
    Promise.resolve().then(() => this.destroyed ? null : this.load(asset.url)).then(image => {
      if (!this.destroyed) item.image = image
    }).catch(() => {
      item.retryAt = this.now() + 30000
      if (!this.destroyed) this.failed()
    }).finally(() => {
      item.loading = false; this.active--
      if (!this.destroyed) this.changed()
    })
    return null
  }
  destroy() { this.destroyed = true; this.items.clear() }
}
module.exports = { PortraitImages }
