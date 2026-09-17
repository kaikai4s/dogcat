class PetBehavior {
  constructor(navigation, stations, start) {
    this.navigation = navigation
    this.stations = stations
    this.position = { ...start }
    this.route = []
    this.phase = 'acting'
    this.action = 'idle'
    this.remaining = 2
    this.hunger = 62
    this.thirst = 48
    this.energy = 80
    this.station = null
    this.moved = 0
    this.heading = 0
  }

  release() {
    if (this.station && this.station.owner === this) this.station.owner = null
    this.station = null
  }

  request(action, destination) {
    const station = this.stations[action]
    if (station && station.owner && station.owner !== this) return false
    const target = station ? station.point : destination
    if (!target) return false
    const route = this.navigation.path(this.position, target)
    if (!route) return false
    this.release()
    if (station) { station.owner = this; this.station = station }
    this.route = route
    this.action = action
    this.phase = 'moving'
    return true
  }

  choose() {
    if (this.energy < 18 && this.request('rest')) return
    if (this.thirst > 78 && this.request('drink')) return
    if (this.hunger > 82 && this.request('eat')) return
    for (let i = 0; i < 12; i += 1) {
      const target = { x: (Math.random() - 0.5) * 124, z: (Math.random() - 0.5) * 88 }
      if (this.request(Math.random() < 0.25 ? 'run' : 'explore', target)) return
    }
    this.action = 'idle'
    this.remaining = 2
  }

  update(dt) {
    this.moved = 0
    this.hunger = Math.min(100, this.hunger + dt * 0.7)
    this.thirst = Math.min(100, this.thirst + dt * 0.95)
    if (this.phase === 'moving') {
      let budget = dt * (this.action === 'run' ? 8 : 4)
      while (this.route.length && budget > 0) {
        const p = this.route[0]
        const dx = p.x - this.position.x; const dz = p.z - this.position.z
        const distance = Math.hypot(dx, dz)
        if (distance < 0.00001) { this.route.shift(); continue }
        const step = Math.min(budget, distance)
        this.heading = Math.atan2(dx, dz)
        this.position.x += dx / distance * step
        this.position.z += dz / distance * step
        this.moved += step
        budget -= step
        if (step === distance) this.route.shift()
      }
      this.energy = Math.max(0, this.energy - dt * (this.action === 'run' ? 1.5 : 0.45))
      if (!this.route.length) {
        this.phase = 'acting'
        this.remaining = this.action === 'rest' ? 10 : ['eat', 'drink'].includes(this.action) ? 6 : 0.8
        if (this.station) this.heading = this.station.heading
      }
    } else {
      this.remaining -= dt
      if (this.action === 'eat') this.hunger = Math.max(0, this.hunger - dt * 12)
      if (this.action === 'drink') this.thirst = Math.max(0, this.thirst - dt * 15)
      if (this.action === 'rest') this.energy = Math.min(100, this.energy + dt * 6)
      if (this.remaining <= 0) { this.release(); this.choose() }
    }
  }
}
module.exports = { PetBehavior }
