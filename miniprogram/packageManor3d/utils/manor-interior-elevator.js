const CALL_RADIUS = 1.15
const DOOR_TIME = .48
const WALK_SPEED = 1.65
const ELEVATOR_SPEED = 1.85
const ease = t => t * t * (3 - 2 * t)
const mix = (a, b, t) => a + (b - a) * t

function createManorInteriorElevator(model, navigation) {
  const lift = navigation.elevator
  const platform = lift && model.getObjectByName(lift.platformNode)
  if (!platform) return null
  const doors = []
  if (lift.doorNodes != null && !Array.isArray(lift.doorNodes)) return null
  for (const entry of lift.doorNodes || []) {
    if (!entry || typeof entry.name !== 'string' || ![entry.dx, entry.dz].every(Number.isFinite) ||
      (entry.floor != null && !lift.landings.some(landing => landing.floor === entry.floor))) return null
    const door = model.getObjectByName(entry.name)
    if (!door || door === platform || doors.some(item => item.door === door)) return null
    doors.push({ door, floor: entry.floor, x: door.position.x, z: door.position.z, dx: entry.dx, dz: entry.dz })
  }
  if (lift.landings.some(landing => !Number.isFinite(navigation.sample(landing.x, landing.z, null, landing.y)))) return null

  const [lower, upper] = lift.landings
  const baseY = platform.position.y
  let current = lower
  let trip = null
  let cachedPosition = null, cachedLanding = null

  function nearby(position) {
    if (!position) return null
    if (cachedPosition && position.x === cachedPosition.x && position.y === cachedPosition.y && position.z === cachedPosition.z) {
      return cachedLanding
    }
    cachedPosition = { x: position.x, y: position.y, z: position.z }
    cachedLanding = lift.landings.find(landing => Math.abs(position.y - landing.y) < .12 &&
      Math.hypot(position.x - landing.x, position.z - landing.z) <= CALL_RADIUS &&
      Number.isFinite(navigation.sampleMove(landing.x, landing.z, position))) || null
    return cachedLanding
  }

  function state(position) {
    if (trip) return { phase: trip.stages[trip.index].phase, targetFloor: trip.destination.floor, busy: true }
    const landing = nearby(position)
    if (!landing) return null
    return { phase: current === landing ? 'ready' : 'call', targetFloor: (landing === lower ? upper : lower).floor, busy: false }
  }

  function start(player) {
    if (trip) return false
    const first = nearby(player?.position)
    if (!first) return false
    const destination = first === lower ? upper : lower
    const begin = { ...cachedPosition }
    const cabinAt = landing => ({ x: landing.x, y: landing.y, z: lift.cabinZ })
    const stages = []
    function walk(from, to, phase) {
      const dx = to.x - from.x, dz = to.z - from.z
      const distance = Math.hypot(dx, dz)
      if (distance <= .001) return
      const yaw = Math.atan2(dx, dz)
      stages.push({ phase, duration: distance / WALK_SPEED, apply(t, dt) {
        player.updateTransport(dt, mix(from.x, to.x, t), mix(from.y, to.y, t), mix(from.z, to.z, t), yaw, true)
      } })
    }
    function operateDoors(landing, opening, phase) {
      stages.push({ phase, duration: DOOR_TIME, apply(t, dt) {
        const fraction = opening ? ease(t) : 1 - ease(t)
        for (const { door, floor, x, z, dx, dz } of doors) {
          if (floor == null || floor === landing.floor) {
            door.position.x = x + dx * fraction
            door.position.z = z + dz * fraction
          }
        }
        player.update(dt)
      } })
    }
    function moveCabin(from, to, occupied) {
      stages.push({ phase: occupied ? 'riding' : 'calling', duration: Math.abs(to.y - from.y) / ELEVATOR_SPEED, apply(t, dt) {
        const y = mix(from.y, to.y, ease(t))
        platform.position.y = baseY + y - lower.y
        if (occupied) player.updateTransport(dt, mix(from.x, to.x, ease(t)), y, lift.cabinZ)
        else player.update(dt)
        if (t === 1) current = to
      } })
    }

    walk(begin, first, current === first ? 'boarding' : 'calling')
    if (current !== first) moveCabin(current, first, false)
    operateDoors(first, true, 'boarding')
    walk(first, cabinAt(first), 'boarding')
    operateDoors(first, false, 'boarding')
    moveCabin(first, destination, true)
    operateDoors(destination, true, 'leaving')
    walk(cabinAt(destination), destination, 'leaving')
    operateDoors(destination, false, 'leaving')
    player.setInput(0, 0)
    trip = { stages, index: 0, elapsed: 0, destination }
    return true
  }

  function update(dt) {
    if (!trip) return false
    while (trip && dt > 0) {
      const stage = trip.stages[trip.index]
      const remaining = stage.duration - trip.elapsed
      const step = Math.min(dt, remaining)
      trip.elapsed += step
      dt -= step
      const finished = step === remaining
      stage.apply(finished ? 1 : trip.elapsed / stage.duration, step)
      if (finished) {
        trip.index++
        trip.elapsed = 0
        if (trip.index === trip.stages.length) trip = null
      }
    }
    return true
  }

  return { state, start, update,
    get busy() { return !!trip },
    get carrying() { return trip?.stages[trip.index].phase === 'riding' }
  }
}

module.exports = { createManorInteriorElevator }
