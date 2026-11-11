// Shared by native touch events and the browser pointer adapter. A change in
// finger count or identity rebases instead of jumping the camera.
class MapGestures {
  constructor(scene) { this.scene = scene; this.previous = null }
  reset() { this.previous = null }
  update(touches) {
    const points = touches.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 2)
    if (!points.length) { this.reset(); return }
    const ids = points.map(p => String(p.id)).join(':')
    const center = points.length === 1 ? points[0] : {
      x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
    const distance = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
    const previous = this.previous
    if (previous && previous.ids === ids) {
      if (points.length === 2 && previous.distance > 4 && distance > 4) {
        this.scene.zoomAt(distance / previous.distance, previous.center, center)
      } else if (points.length === 1) this.scene.pan(center.x - previous.center.x, center.y - previous.center.y)
    }
    this.previous = { ids, center, distance }
  }
}
module.exports = { MapGestures }
