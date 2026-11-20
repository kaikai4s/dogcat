const SEATS = Object.freeze([
  { id: 'driver', label: '主驾驶', side: 1, door: 'L', mount: 'Seat_FL_Anchor' },
  { id: 'passenger', label: '副驾驶', side: -1, door: 'R', mount: 'Seat_FR_Anchor' }
])
const NEAR = 7
const WALK_SPEED = 2.45
const HALF_WIDTH = 1.10
const FRONT = 2.42
const REAR = -2.33
const DOOR_STEP = 1.59
const MAX_FORWARD = 12
const MAX_REVERSE = 4
const BOARD_TIME = .88
const SEATED_EYE_HEIGHT = .69
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const smooth = value => value * value * (3 - 2 * value)
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const heading = (a, b) => Math.atan2(b.x - a.x, b.z - a.z)
const approach = (current, target, delta) => current + clamp(target - current, -delta, delta)

function worldPoint(origin, yaw, x, z) {
  const s = Math.sin(yaw), c = Math.cos(yaw)
  return { x: origin.x + x * c + z * s, z: origin.z - x * s + z * c }
}

function footprint(sample, x, z, yaw) {
  let low = Infinity, high = -Infinity, total = 0
  for (const offsetX of [-HALF_WIDTH, 0, HALF_WIDTH]) {
    for (const offsetZ of [REAR, 0, FRONT]) {
      const point = worldPoint({ x, z }, yaw, offsetX, offsetZ)
      const y = sample(point.x, point.z)
      if (!Number.isFinite(y)) return null
      low = Math.min(low, y)
      high = Math.max(high, y)
      total += y
    }
  }
  return high - low > .62 ? null : total / 9
}

function validParking(sample, candidate) {
  if (![candidate?.x, candidate?.z, candidate?.yaw].every(Number.isFinite)) return null
  const y = footprint(sample, candidate.x, candidate.z, candidate.yaw)
  if (y === null) return null
  const sidePoints = [-1, 1].map(side => worldPoint(candidate, candidate.yaw, side * DOOR_STEP, -.78))
  if (!sidePoints.every(point => {
    const ground = sample(point.x, point.z)
    return Number.isFinite(ground) && Math.abs(ground - y) < .42
  })) return null
  return { x: candidate.x, y, z: candidate.z, yaw: candidate.yaw }
}

function parkingSpot(sample, spawn) {
  for (const radius of [5, 6, 8, 11, 15, 22]) {
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8
      const yaw = angle + Math.PI / 2
      const { x, z } = worldPoint(spawn, angle, 0, radius)
      const parked = validParking(sample, { x, z, yaw })
      if (parked) return parked
    }
  }
  return null
}

function createManorVehicle({ THREE, model, scene, player, sample, spawn, saved, disposeModel, onMove }) {
  const doors = { L: model.getObjectByName('Door_L'), R: model.getObjectByName('Door_R') }
  const wheel = model.getObjectByName('Steering_Wheel')
  const steering = ['Steer_FL', 'Steer_FR'].map(name => model.getObjectByName(name))
  const tires = ['Spin_FL', 'Spin_FR', 'Spin_RL', 'Spin_RR'].map(name => model.getObjectByName(name))
  if (!doors.L || !doors.R || !wheel || [...steering, ...tires].some(node => !node)) {
    throw new Error('Copper GT 缺少车门、车轮或方向盘节点')
  }
  const parked = validParking(sample, {
    x: saved?.position3d?.x,
    z: saved?.position3d?.z,
    yaw: saved?.yaw
  }) || parkingSpot(sample, spawn)
  if (!parked) throw new Error('附近没有适合停放 Copper GT 的位置')

  const anchor = new THREE.Group()
  anchor.name = 'Manor Copper GT'
  anchor.position.set(parked.x, parked.y, parked.z)
  anchor.rotation.y = parked.yaw
  model.traverse(node => { if (node.isMesh) node.castShadow = true })
  anchor.add(model)
  scene.add(anchor)
  const mounts = new Map(SEATS.map(({ id, mount }) => [id, model.getObjectByName(mount)]))

  let seat = null, passage = null, speed = 0, steer = 0, spin = 0
  let inputX = 0, inputY = 0, braking = false
  const point = (x, z) => worldPoint(anchor.position, anchor.rotation.y, x, z)
  const grounded = (x, z) => {
    const p = point(x, z)
    const y = sample(p.x, p.z)
    return Number.isFinite(y) && Math.abs(y - anchor.position.y) < .49 ? { ...p, y } : null
  }
  const doorStep = selected => grounded(selected.side * DOOR_STEP, -.78)
  // Fitted clips include their seat height. The marker specifies the model root, not the cushion.
  const seatPoint = selected => mounts.get(selected.id)?.getWorldPosition(new THREE.Vector3()) ||
    { ...point(selected.side * .414, -.17), y: anchor.position.y - .04 }
  const seatBlend = (selected, progress) => mounts.get(selected.id) ? progress : 0
  const busy = () => !!(seat || passage)

  function blocks(x, z) {
    const dx = x - anchor.position.x, dz = z - anchor.position.z
    if (Math.abs(dx) > 3.3 || Math.abs(dz) > 3.3) return false
    const s = Math.sin(anchor.rotation.y), c = Math.cos(anchor.rotation.y)
    const localX = dx * c - dz * s, localZ = dx * s + dz * c
    return Math.abs(localX) < HALF_WIDTH + .29 && localZ > REAR - .29 && localZ < FRONT + .29
  }

  function clear(a, b) {
    const steps = Math.max(1, Math.ceil(distance(a, b) / .22))
    let y = a.y
    for (let i = 1; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, z = a.z + (b.z - a.z) * i / steps
      const ground = sample(x, z)
      if (blocks(x, z) || !Number.isFinite(ground) || Math.abs(ground - y) > .30) return false
      y = ground
    }
    return true
  }

  function routeTo(start, end) {
    if (clear(start, end)) return [end]
    const corners = [-1, 1].flatMap(side => [REAR - .65, FRONT + .65].map(z => grounded(side * 1.69, z))).filter(Boolean)
    const points = [start, end, ...corners]
    const costs = points.map(() => Infinity), from = [], done = new Set()
    costs[0] = 0
    for (let visited = 0; visited < points.length; visited++) {
      let next = -1
      costs.forEach((cost, index) => {
        if (!done.has(index) && cost < (next < 0 ? Infinity : costs[next])) next = index
      })
      if (next < 0 || next === 1) break
      done.add(next)
      points.forEach((candidate, index) => {
        const cost = costs[next] + distance(points[next], candidate)
        if (!done.has(index) && cost < costs[index] && clear(points[next], candidate)) {
          costs[index] = cost
          from[index] = next
        }
      })
    }
    if (!Number.isFinite(costs[1])) return null
    const route = []
    for (let index = 1; index !== 0; index = from[index]) route.unshift(points[index])
    return route
  }

  function nearby() {
    return !!player.position && distance(player.position, anchor.position) <= NEAR
  }

  function enter(id) {
    const selected = SEATS.find(item => item.id === id)
    if (busy() || !nearby() || !selected) return false
    const outside = doorStep(selected)
    const route = outside && routeTo(player.position, outside)
    if (!route) return false
    player.setInput(0, 0)
    passage = { selected, outside, route, phase: 'walk', elapsed: 0 }
    return true
  }

  function exit() {
    if (!seat || passage || Math.abs(speed) > .10) return false
    const outside = doorStep(seat)
    if (!outside) return false
    speed = inputX = inputY = 0
    braking = false
    passage = { selected: seat, outside, phase: 'push', elapsed: 0, exiting: true }
    return true
  }

  function setInput(x, y) {
    if (seat?.id !== 'driver' || passage) return
    inputX = Math.abs(x) > .10 ? clamp(x, -1, 1) : 0
    inputY = Math.abs(y) > .10 ? clamp(y, -1, 1) : 0
    if (inputY === 0) braking = false
  }

  function brake() {
    if (seat?.id !== 'driver' || passage) return false
    braking = true
    inputX = inputY = 0
    return true
  }

  function updateDriving(dt) {
    const forward = -inputY
    const target = forward * (forward < 0 ? MAX_REVERSE : MAX_FORWARD)
    const reversing = target * speed < 0
    speed = approach(speed, reversing ? 0 : target, (braking || reversing ? 17 : target ? 6 : 3.8) * dt)
    if (!speed) braking = false
    steer = approach(steer, -inputX, dt * 4.5)
    steering.forEach(node => { node.rotation.y = steer * .43 })
    wheel.rotation.y = steer * -1.885
    const steps = Math.max(1, Math.ceil(Math.abs(speed) * dt / .32))
    for (let step = 0; step < steps && speed; step++) {
      const delta = speed * dt / steps
      const yaw = anchor.rotation.y + delta * Math.tan(steer * .43) / 2.8
      const next = worldPoint(anchor.position, (yaw + anchor.rotation.y) / 2, 0, delta)
      const y = footprint(sample, next.x, next.z, yaw)
      if (y === null || Math.abs(y - anchor.position.y) > .38) {
        speed = 0
        break
      }
      anchor.position.set(next.x, y, next.z)
      anchor.rotation.y = yaw % (2 * Math.PI)
      spin = (spin + delta / .348) % (2 * Math.PI)
      onMove()
    }
    tires.forEach(node => { node.rotation.x = spin })
  }

  function pose(dt, p, yaw, motion) {
    player.updateTransport(dt, p.x, p.y, p.z, yaw, motion)
  }

  function handle(selected, inside) {
    return doors[selected.door].localToWorld(new THREE.Vector3(
      selected.side * (inside ? -.09 : .10), inside ? .15 : .175, inside ? -.44 : -1.20))
  }

  function updatePassage(dt) {
    const { selected, outside, route, phase } = passage
    const yaw = anchor.rotation.y, facingDoor = yaw - selected.side * Math.PI / 2
    const chair = seatPoint(selected)
    const door = doors[selected.door]
    if (phase === 'walk') {
      const start = player.position, end = route[0]
      const length = distance(start, end)
      const f = length ? Math.min(1, dt * WALK_SPEED / length) : 1
      const x = start.x + (end.x - start.x) * f, z = start.z + (end.z - start.z) * f
      const y = sample(x, z)
      if (!Number.isFinite(y) || blocks(x, z)) {
        passage = null
        return
      }
      pose(dt, { x, y, z }, f === 1 && route.length === 1 ? facingDoor : heading(start, end), true)
      if (f === 1) route.shift()
      if (!route.length) passage.phase = 'pull'
      return
    }
    const duration = phase === 'board' || phase === 'stand' ? BOARD_TIME : .52
    passage.elapsed += dt
    const f = clamp(passage.elapsed / duration, 0, 1), t = smooth(f)
    const opening = phase === 'pull' || phase === 'push'
    if (opening || phase === 'closeInside' || phase === 'closeOutside') {
      const swing = opening ? t : 1 - t
      door.rotation.y = swing ? -selected.side * Math.PI / 3 * swing : 0
      const inside = phase === 'push' || phase === 'closeInside'
      pose(dt, inside ? chair : outside, inside ? yaw : facingDoor, {
        action: 'reach', seated: inside, side: selected.side, progress: f, handle: handle(selected, inside),
        seatBlend: seatBlend(selected, inside ? 1 : 0)
      })
      onMove()
    } else {
      const amount = phase === 'board' ? t : 1 - t
      const p = {
        x: outside.x + (chair.x - outside.x) * amount,
        y: outside.y + (chair.y - outside.y) * amount + Math.sin(amount * Math.PI) * .18,
        z: outside.z + (chair.z - outside.z) * amount
      }
      pose(dt, p, facingDoor + (yaw - facingDoor) * amount, {
        action: phase === 'board' ? 'board' : 'exit', side: selected.side, progress: f,
        seatBlend: seatBlend(selected, amount)
      })
    }
    if (f < 1) return
    passage.elapsed = 0
    if (phase === 'pull') passage.phase = 'board'
    else if (phase === 'board') passage.phase = 'closeInside'
    else if (phase === 'push') passage.phase = 'stand'
    else if (phase === 'stand') passage.phase = 'closeOutside'
    else {
      seat = passage.exiting ? null : selected
      passage = null
    }
  }

  function update(dt) {
    if (!busy()) return false
    if (dt <= 0) return true
    if (passage) updatePassage(dt)
    else {
      const driver = seat.id === 'driver'
      if (driver) updateDriving(dt)
      pose(dt, seatPoint(seat), anchor.rotation.y, {
        action: driver ? 'drive' : 'seated', steering: steer, wheel, seatBlend: seatBlend(seat, 1)
      })
    }
    return true
  }

  function state() {
    const selected = passage?.selected || seat
    const status = {
      walk: '正在走向车门', pull: '正在打开车门', push: '正在打开车门',
      board: '正在上车', stand: '正在下车', closeInside: '正在关门', closeOutside: '正在关门'
    }[passage?.phase] || ''
    return {
      nearby: !busy() && nearby(),
      mode: passage ? (passage.exiting ? 'exiting' : 'entering') : seat?.id || 'walking',
      status, seatLabel: selected?.label || '', speed: Math.round(Math.abs(speed) * 3.6),
      canExit: !!seat && !passage && Math.abs(speed) <= .10,
      seats: SEATS.map(({ id, label }) => ({ id, label, occupied: selected?.id === id }))
    }
  }

  function viewpoint(standingEyeHeight) {
    const selected = passage?.selected || seat
    const phase = passage?.phase
    if (!selected || phase === 'walk') return null
    let seated = 1
    if (phase === 'pull' || phase === 'closeOutside') seated = 0
    if (phase === 'board' || phase === 'stand') {
      const blend = smooth(clamp(passage.elapsed / BOARD_TIME, 0, 1))
      seated = phase === 'board' ? blend : 1 - blend
    }
    const yaw = anchor.rotation.y - selected.side * Math.PI / 2 * (1 - seated)
    const height = standingEyeHeight + (player.height * SEATED_EYE_HEIGHT - standingEyeHeight) * seated
    const position = worldPoint(player.position, yaw, 0, -.10 * seated)
    return { ...position, y: player.position.y + height, yaw }
  }

  function checkpoint() {
    if (!busy()) return null
    const selected = passage?.selected || seat
    const p = doorStep(selected) || doorStep(SEATS.find(item => item !== selected)) || spawn
    return { ...p, facing: anchor.rotation.y }
  }

  function syncState() {
    return {
      position3d: { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z },
      yaw: anchor.rotation.y,
      moving: Math.abs(speed) > .04
    }
  }

  function restore(record) {
    if (busy()) return false
    const parked = validParking(sample, {
      x: record?.position3d?.x,
      z: record?.position3d?.z,
      yaw: record?.yaw
    })
    if (!parked) return false
    speed = inputX = inputY = 0
    braking = false
    anchor.position.set(parked.x, parked.y, parked.z)
    anchor.rotation.y = parked.yaw
    onMove()
    return true
  }

  function clearInput() {
    inputX = inputY = 0
    speed = 0
    braking = false
  }

  function dispose() {
    anchor.remove(model)
    anchor.removeFromParent()
    disposeModel(model)
  }

  return { blocks, busy, enter, exit, setInput, brake, update, state, viewpoint, checkpoint, syncState,
    restore, clearInput, dispose }
}

module.exports = { createManorVehicle }
