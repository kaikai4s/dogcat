const CHARACTER_RADIUS = 0.8
const CHARACTER_SPEED = 7
const CHARACTER_RUN_SPEED = 14
const RUN_START = 0.72
const RUN_STOP = 0.62
const INTERACTION_DISTANCE = 4

function screenMovement(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, z: 0, strength: 0 }
  const strength = Math.min(1, Math.hypot(x, y))
  if (strength < 0.12) return { x: 0, z: 0, strength: 0 }
  const dx = (x + y / 0.52) / 2
  const dz = (y / 0.52 - x) / 2
  const length = Math.hypot(dx, dz)
  return { x: dx / length, z: dz / length, strength }
}

class PlayerCharacter {
  constructor(position) {
    this.position = { ...position }
    this.input = { x: 0, y: 0 }
    this.moving = false
    this.mirrored = false
    this.walkDistance = 0
    this.runRequested = false
    this.animationPhase = 0
  }
  setInput(x, y) {
    this.input = {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0
    }
    if (this.input.x > 0.05) this.mirrored = true
    else if (this.input.x < -0.05) this.mirrored = false
    const strength = screenMovement(this.input.x, this.input.y).strength
    this.runRequested = strength >= (this.runRequested ? RUN_STOP : RUN_START)
    if (!strength) this.moving = false
  }
  update(dt, navigation, known) {
    this.moving = false
    const vector = screenMovement(this.input.x, this.input.y)
    if (!vector.strength || !navigation || !Number.isFinite(dt) || dt <= 0) return
    // Bounded substeps prevent crossing a narrow fence during a slow frame.
    const strength = vector.strength
    const speed = strength <= RUN_START
      ? CHARACTER_SPEED * (strength - 0.12) / (RUN_START - 0.12)
      : CHARACTER_SPEED + (CHARACTER_RUN_SPEED - CHARACTER_SPEED) * (strength - RUN_START) / (1 - RUN_START)
    let remaining = speed * Math.min(dt, 0.1)
    while (remaining > 0.00001) {
      const distance = Math.min(0.2, remaining)
      const start = this.position
      const next = { x: start.x + vector.x * distance, z: start.z + vector.z * distance }
      const allowed = (p) => known(p) && navigation.clearSegment(start, p)
      let target = null
      if (allowed(next)) target = next
      else {
        const alongX = { x: next.x, z: start.z }
        const alongZ = { x: start.x, z: next.z }
        if (Math.abs(vector.x) >= Math.abs(vector.z)) {
          if (allowed(alongX)) target = alongX
          else if (allowed(alongZ)) target = alongZ
        } else {
          if (allowed(alongZ)) target = alongZ
          else if (allowed(alongX)) target = alongX
        }
      }
      if (!target) break
      const moved = Math.hypot(target.x - start.x, target.z - start.z)
      this.walkDistance += moved
      this.animationPhase = (this.animationPhase + moved / (this.runRequested ? 9.5 : 7)) % 1
      this.moving = this.moving || moved > 0.00001
      this.position = target
      remaining -= distance
    }
  }
}
module.exports = { PlayerCharacter, screenMovement, CHARACTER_RADIUS, CHARACTER_SPEED, CHARACTER_RUN_SPEED, RUN_START, RUN_STOP, INTERACTION_DISTANCE }
