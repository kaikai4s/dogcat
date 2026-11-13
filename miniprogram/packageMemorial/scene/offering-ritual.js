const { findRoute, clearLine } = require('./navigation')
const worldIndex = require('./world-index')
const { slot, activeCounts, MAX_VISIBLE } = require('./offerings')
const cancelled = () => new Error('已结束摆放心意')
class OfferingRitual {
  constructor(scene) { this.scene = scene; this.version = 0; this.state = null }
  cancel() {
    this.version++
    const state = this.state
    this.state = null
    if (state) { this.scene.input = { x: 0, y: 0 }; this.scene.moving = false; if (state.reject) state.reject(cancelled()) }
  }
  async approach(memorial, kind) {
    if (!['flower', 'snack'].includes(kind) || !memorial || !memorial.applicationId) throw new Error('请重新选择小筑')
    this.cancel()
    const s = this.scene, version = this.version, gender = s.gender
    await Promise.all([s.image('offerings-v1/' + gender + '-' + kind + '.png'), s.image('offerings-v1/' + kind + '.png')])
    if (version !== this.version || s.destroyed) throw cancelled()
    if (!s.memorials.some(row => row.applicationId === memorial.applicationId)) throw new Error('小筑位置已变化，请刷新')
    const count = activeCounts(memorial.offeringScene, s.environment.time())[kind]
    const place = slot(memorial, kind, Math.min(count, MAX_VISIBLE - 1))
    // Both rear-view gestures reach toward upper left. Keep boots outside the stone collider.
    const target = { x: place.x + 25, y: Math.max(memorial.y + 38, place.y + 15) }
    const obstacles = worldIndex.objects.concat(s.memorials)
    const route = findRoute(s.player, target, s.memorials)
    if (!route.length || !clearLine(route[route.length - 1], target, obstacles)) throw new Error('小筑前方暂不可通行，请走近后重试')
    route.push(target)
    s.cancelNavigation(); s.input = { x: 0, y: 0 }; s.followPlayer()
    return new Promise((resolve, reject) => {
      this.state = { phase: 'approach', id: memorial.applicationId, kind, gender, route: route.slice(1), resolve, reject, stalled: 0, elapsed: 0 }
    })
  }
  gesture(onRelease) {
    const state = this.state
    if (!state || state.phase !== 'ready') return Promise.reject(cancelled())
    state.phase = 'gesture'; state.elapsed = 0; state.onRelease = onRelease; this.scene.direction = 'nw'
    return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject })
  }
  step(dt) {
    const state = this.state, s = this.scene
    if (!state) return
    if (!s.memorials.some(row => row.applicationId === state.id) || s.gender !== state.gender) { this.cancel(); return }
    if (state.phase === 'gesture') {
      s.input = { x: 0, y: 0 }; s.direction = 'nw'; state.elapsed += dt
      if (state.elapsed >= 1.35 && state.onRelease) { const release = state.onRelease; state.onRelease = null; release() }
      if (state.elapsed >= 2.4) { this.state = null; state.reject = null; state.resolve() }
      return
    }
    if (state.phase !== 'approach') { s.input = { x: 0, y: 0 }; return }
    state.elapsed += dt
    while (state.route.length && Math.hypot(state.route[0].x - s.player.x, state.route[0].y - s.player.y) < 2) state.route.shift()
    if (!state.route.length) {
      state.phase = 'ready'; s.direction = 'nw'; s.input = { x: 0, y: 0 }; s.moving = false
      state.reject = null; state.resolve(); return
    }
    const point = state.route[0], dx = point.x - s.player.x, dy = point.y - s.player.y, distance = Math.hypot(dx, dy)
    const travel = Math.min(120 * dt, distance), next = { x: s.player.x + dx / distance * travel, y: s.player.y + dy / distance * travel }
    if (s.canWalk(next)) { s.input = { x: dx / distance * Math.min(1, distance / Math.max(120 * dt, .001)), y: dy / distance * Math.min(1, distance / Math.max(120 * dt, .001)) }; state.stalled = 0 }
    else { s.input = { x: 0, y: 0 }; state.stalled += dt }
    if (state.stalled > 15 || state.elapsed > 180) { state.reject(new Error('前往小筑的路线暂不可通行，请走近后重试')); state.reject = null; this.cancel() }
  }
  frame() { return this.state && this.state.phase === 'gesture' ? Math.min(7, Math.floor(this.state.elapsed / .3)) : null }
}
module.exports = { OfferingRitual }
