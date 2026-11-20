const CALL_RADIUS = 1.15
const FLOOR_TOLERANCE = .12
const WALK_SPEED = 1.65

// Courtyard lift clips contain only translations. Sample those tracks on this
// placed copy so their final poses persist until the next clip starts.
function translationClip(model, name, nodes) {
  const clip = model.animations.find(item => item.name === name)
  if (!clip || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.tracks.length !== nodes.length) return null
  const tracks = nodes.map(node => {
    const track = clip.tracks.find(item => item.name === node.name + '.position')
    return track?.getValueSize() === 3 && track.times.length ? track.createInterpolant() : null
  })
  if (tracks.some(track => !track)) return null
  return { duration: clip.duration, pose(time) {
    nodes.forEach((node, i) => node.position.fromArray(tracks[i].evaluate(time)))
  } }
}

function createCourtyardElevator({ THREE, model, navigation, landings = [] }) {
  if (landings.length !== 3 || !Array.isArray(model?.animations)) return null
  const byFloor = new Map(landings.map(landing => [landing.level, landing]))
  const floors = [1, 2, 3]
  const car = model.getObjectByName('LiftCar')
  if (!car || floors.some(floor => !byFloor.has(floor))) return null
  const initial = new Map([[car, car.position.clone()]])
  const doors = new Map(), rides = new Map()
  for (const floor of floors) {
    const nodes = [1, 2].map(leaf => model.getObjectByName('E' + floor + '_Slide_' + leaf))
    if (nodes.some(node => !node)) return null
    const open = translationClip(model, 'E' + floor + '_Open', nodes)
    const close = translationClip(model, 'E' + floor + '_Close', nodes)
    if (!open || !close) return null
    doors.set(floor, { open, close })
    for (const node of nodes) initial.set(node, node.position.clone())
    for (const to of floors.filter(level => level !== floor)) {
      const clip = translationClip(model, 'Lift_F' + floor + '_to_F' + to, [car])
      if (!clip) return null
      rides.set(floor * 10 + to, clip)
    }
  }

  let current = 1, trip = null, disposed = false
  const carStart = new THREE.Vector3(), rider = new THREE.Vector3(), walkPoint = new THREE.Vector3()

  function nearby(position) {
    if (!position) return null
    return landings.find(({ approach }) => Math.abs(position.y - approach.y) < FLOOR_TOLERANCE &&
      Math.hypot(position.x - approach.x, position.z - approach.z) <= CALL_RADIUS &&
      Math.abs((navigation.sampleMove(approach.x, approach.z, position) ?? Infinity) - approach.y) < FLOOR_TOLERANCE) || null
  }

  function defaultDestination(floor) {
    return floor === 3 ? 2 : floor + 1
  }

  function state(position) {
    if (disposed) return null
    if (trip) return { phase: trip.stages[trip.index].phase, floor: trip.first.level,
      targetFloor: trip.destination.level, busy: true }
    const landing = nearby(position)
    if (!landing) return null
    const floor = landing.level
    return { phase: current === floor ? 'ready' : 'call', floor, targetFloor: defaultDestination(floor),
      destinations: floors.filter(level => level !== floor), busy: false }
  }

  function start(player, targetFloor) {
    if (disposed || trip) return false
    const first = nearby(player?.position)
    if (!first) return false
    const destination = byFloor.get(targetFloor ?? defaultDestination(first.level))
    if (!destination || destination === first) return false

    const stages = []
    const hold = dt => {
      const { x, y, z } = player.position
      player.updateTransport(dt, x, y, z)
    }
    function walk(from, to, phase, yaw) {
      const distance = Math.hypot(to.x - from.x, to.z - from.z)
      if (distance <= .001) return
      stages.push({ phase, duration: distance / WALK_SPEED, apply(t, dt) {
        walkPoint.lerpVectors(from, to, t)
        player.updateTransport(dt, walkPoint.x, walkPoint.y, walkPoint.z, yaw, true)
      } })
    }
    function slide(landing, open, phase) {
      const clip = doors.get(landing.level)[open ? 'open' : 'close']
      stages.push({ phase, duration: clip.duration, apply(t, dt) {
        clip.pose(t * clip.duration)
        hold(dt)
      } })
    }
    function travel(from, to, occupied) {
      const clip = rides.get(from.level * 10 + to.level)
      let started = false
      stages.push({ phase: occupied ? 'riding' : 'calling', duration: clip.duration, apply(t, dt) {
        if (occupied && !started) {
          clip.pose(0)
          car.getWorldPosition(carStart)
          started = true
        }
        clip.pose(t * clip.duration)
        if (occupied) {
          if (t === 1) rider.copy(to.cabin)
          else car.getWorldPosition(rider).sub(carStart).add(from.cabin)
          player.updateTransport(dt, rider.x, rider.y, rider.z)
        } else hold(dt)
        if (t === 1) current = to.level
      } })
    }

    const point = new THREE.Vector3().copy(player.position)
    walk(point, first.approach, current === first.level ? 'boarding' : 'calling',
      Math.atan2(first.approach.x - point.x, first.approach.z - point.z))
    if (current !== first.level) travel(byFloor.get(current), first, false)
    slide(first, true, 'boarding')
    walk(first.approach, first.cabin, 'boarding', first.yaw)
    slide(first, false, 'boarding')
    travel(first, destination, true)
    slide(destination, true, 'leaving')
    walk(destination.cabin, destination.approach, 'leaving', destination.yaw + Math.PI)
    slide(destination, false, 'leaving')
    player.setInput(0, 0)
    trip = { first, destination, stages, index: 0, elapsed: 0 }
    return true
  }

  function update(dt) {
    if (!trip) return false
    while (trip && dt > 0) {
      const stage = trip.stages[trip.index]
      const remaining = stage.duration - trip.elapsed
      const step = Math.min(remaining, dt)
      const done = step === remaining
      trip.elapsed += step
      dt -= step
      stage.apply(done ? 1 : trip.elapsed / stage.duration, step)
      if (done) {
        trip.elapsed = 0
        if (++trip.index === trip.stages.length) trip = null
      }
    }
    return true
  }

  function checkpoint(position) {
    if (!trip || !position) return null
    const { x, y, z } = position
    const ground = navigation.sample(x, z, null, y)
    if (Number.isFinite(ground) && Math.abs(ground - y) < FLOOR_TOLERANCE) return { x, y: ground, z }
    const { first, destination } = trip
    const landing = Math.abs(y - first.approach.y) <= Math.abs(y - destination.approach.y) ? first : destination
    return landing.approach
  }

  function dispose() {
    disposed = true
    trip = null
    for (const [node, position] of initial) node.position.copy(position)
  }

  return { state, start, update, checkpoint, dispose,
    get busy() { return !!trip },
    get carrying() { return trip?.stages[trip.index].phase === 'riding' }
  }
}

module.exports = { createCourtyardElevator }
