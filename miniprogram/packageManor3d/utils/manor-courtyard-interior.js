const { createNativeCourtyard } = require('./manor-courtyard-native')

// Metres in the Songying Courtyard Villa asset (north is negative Z).
const ENTRANCES = [
  { id: 'north', label: '北侧正门', x: 7.70, z: 0, left: 6.95, right: 8.45, inward: 1 },
  { id: 'south', label: '南侧花园门', x: 7.80, z: 14, left: 6.90, right: 8.70, inward: -1 }
]
const FLOOR_Y = [.22, 3.82, 7.12]
const RADIUS = .24
const EPSILON = 1e-5
const STAIR_FRONT = 6.13
const STAIR_TURN = 3.38
const WEST = [8.91, 9.95]
const EAST = [10.05, 11.09]
const FACADES = [
  ['Dark bronze window frames', 'stile'],
  ['Glazing: low iron window', 'glass'],
  ['Elevator champagne steel', 'handles']
]

// Solid partitions are the spans between the openings in the floor plans.
// [x0, z0, x1, z1]; furniture is stored as [minX, maxX, minZ, maxZ].
const WALLS = [
  [[0,3.4,3,3.4], [4.15,3.4,6.9,3.4], [4.25,0,4.25,3.4],
    [6.9,0,6.9,1.4], [6.9,2.51,6.9,4.35], [6.9,5.6,6.9,8.65], [6.9,10.05,6.9,14],
    [0,7.35,.65,7.35], [6.45,7.35,6.9,7.35], [12.9,0,12.9,3.7], [12.9,4.9,12.9,5.66],
    [12.9,6.9,12.9,9.15], [12.9,10.45,12.9,14], [12.9,5.25,16,5.25], [12.9,7.35,16,7.35]],
  [[6.9,0,6.9,3.53], [6.9,4.68,6.9,8.2], [6.9,9.35,6.9,14], [0,5.05,6.9,5.05],
    [12.9,4,16,4], [12.9,0,12.9,2.4], [12.9,3.55,12.9,7.15], [12.9,8.28,12.9,14],
    [3.15,5.05,3.15,7.55], [5.6,5.05,5.6,7.55], [0,7.55,1.9,7.55],
    [3.04,7.55,4.1,7.55], [5.16,7.55,5.6,7.55]],
  [[6.9,0,6.9,4.05], [6.9,5.22,6.9,5.9], [0,5.9,6.9,5.9], [4,5.9,4,7.32],
    [4,8.45,4,10], [12.9,6.6,16,6.6], [12.9,0,12.9,4.9], [12.9,6.08,12.9,7.22], [12.9,8.35,12.9,10]]
]
const CORE = [[8.5,0,8.5,6.6], [11.5,0,11.5,6.6], [8.5,6.6,8.98,6.6], [11.02,6.6,11.5,6.6]]
const FURNITURE = [
  [[.16,.85,.24,3.16], [3.25,4.08,.16,.72], [1.58,3.22,1.32,2.02], [4.37,4.99,1.73,3.17],
    [4.46,5.77,.19,.87], [1.70,5.18,4.80,5.82], [4.52,6.34,3.50,3.98],
    [1.43,5.09,8.56,9.54], [2.45,4.13,10.28,11.04], [.76,1.41,10.56,11.26],
    [5.20,5.84,10.77,11.44], [6.33,6.79,11.08,13.12],
    [13.22,15.26,1.17,2.67], [15.30,15.86,3.31,4.93], [14.29,15.31,5.28,5.94],
    [14.76,15.81,6.17,7.20], [13.38,13.89,6.75,7.30], [13.09,15.83,11.01,13.71],
    [13.65,15.37,7.44,7.94], [9.18,10.82,9.11,9.24], [9.35,10.99,11.68,12.10]],
  [[.95,2.99,1.07,2.57], [4.03,6.23,.18,.80], [5.24,5.80,1.42,2.82],
    [13.22,15.25,5.24,6.74], [15.27,15.86,8.38,9.70], [13.09,13.61,8.97,10.35],
    [4.50,6.62,9.88,11.72], [.22,1.60,7.67,8.23], [7.44,8.24,9.60,11.38], [8.48,9.18,10.11,10.81]],
  [[1.38,3.92,2.00,2.82], [.29,5.05,5.31,5.77], [.58,3,6.08,6.94], [.76,1.90,7.57,8.25],
    [5.01,7.77,6.42,7.32], [5.45,6.71,7.82,8.42], [13.13,13.97,3.15,4.12],
    [14.75,15.61,3.18,4.14], [13.27,15.59,6.04,6.48], [13.2,14.73,6.7,7.2]]
]

function inRange(value, low, high) {
  return value >= low - EPSILON && value <= high + EPSILON
}

function inLane(x, [left, right]) {
  return inRange(x, left + RADIUS, right - RADIUS)
}

function nearBox(x, z, [minX, maxX, minZ, maxZ], margin = RADIUS) {
  const dx = Math.max(minX - x, 0, x - maxX)
  const dz = Math.max(minZ - z, 0, z - maxZ)
  return dx * dx + dz * dz < margin * margin
}

function makeSurfaces(native) {
  const heights = native?.floorY || FLOOR_Y
  const collision = native?.levelCollision || WALLS.map((spans, level) => ({
    walls: CORE.concat(spans).map(([x0, z0, x1, z1]) => [x0, x1, z0, z1]), furniture: FURNITURE[level]
  }))
  const floors = heights.map((y, level) => ({
    level,
    height: () => y,
    contains(x, z, clearance = RADIUS) {
      const width = native?.floors[level].width ?? 16
      const depth = native?.floors[level].terraceEdge ?? (level === 2 ? 10 : 14)
      const atDoor = level === 0 && ENTRANCES.some(door =>
        inRange((z - door.z) * door.inward, -.12, .22 + RADIUS) &&
        inRange(x, door.left + .065 + RADIUS, door.right - .065 - RADIUS))
      if (!atDoor && (!inRange(x, .22 + RADIUS, width - .22 - RADIUS) ||
          !inRange(z, .22 + RADIUS, depth - .22 - RADIUS))) return false
      if (nearBox(x, z, [8.86, 11.14, 2.63, STAIR_FRONT]) &&
          (!inRange(z, STAIR_FRONT, STAIR_FRONT + RADIUS) ||
            !(level < 2 && inLane(x, WEST) || level > 0 && inLane(x, EAST)))) return false
      const { walls, furniture } = collision[level]
      return !walls.some(box => nearBox(x, z, box, native ? RADIUS : .075 + RADIUS)) &&
        !furniture.some(box => nearBox(x, z, box)) &&
        (!native || native.doorClearance(level, x, z) >= clearance)
    }
  }))
  const surfaces = [...floors]
  const links = new Map()
  function link(a, b) {
    if (!links.has(a)) links.set(a, new Set())
    if (!links.has(b)) links.set(b, new Set())
    links.get(a).add(b)
    links.get(b).add(a)
  }
  for (let i = 0; i < floors.length - 1; i++) {
    const base = heights[i], top = heights[i + 1], half = (base + top) / 2
    const landing = {
      height: () => half,
      contains: (x, z) => inRange(x, WEST[0] + RADIUS, EAST[1] - RADIUS) &&
        inRange(z, 2.65 + RADIUS, STAIR_TURN)
    }
    function flight(lane, fromZ, toZ, fromY, toY) {
      return {
        contains: (x, z) => inLane(x, lane) && inRange(z, STAIR_TURN, STAIR_FRONT),
        height(z) {
          const step = Math.max(0, Math.min(10, Math.ceil((z - fromZ) / (toZ - fromZ) * 10 - EPSILON)))
          return fromY + (toY - fromY) * step / 10
        }
      }
    }
    const west = flight(WEST, STAIR_FRONT, STAIR_TURN, base, half)
    const east = flight(EAST, STAIR_TURN, STAIR_FRONT, half, top)
    link(floors[i], west)
    link(west, landing)
    link(landing, east)
    link(east, floors[i + 1])
    surfaces.push(west, landing, east)
  }
  return { surfaces, links }
}

// Authored in the uploaded model's F1 coordinate frame. Pose heights align the
// avatar to the upholstery; entry and exit stay on the walkable floor.
const REST_SPOTS = [
  { id: 'living-sofa-left', kind: 'sit', name: '客厅沙发', floor: 0, position: [1.97, 0.5535, 9.194],
    entry: [1.97,9.94], yaw: 0 },
  { id: 'living-sofa-right', kind: 'sit', name: '客厅沙发', floor: 0, position: [4.54, 0.5535, 9.194],
    entry: [4.54,9.94], yaw: 0 },
  // The lying clips extend farther toward the headboard than toward the foot of the bed.
  { id: 'main-bedroom-bed', kind: 'lie', name: '主卧床', floor: 1, position: [5.24, 4.437, 10.82],
    entry: [4.1,10.82], yaw: -Math.PI / 2 }
]

const legacySurfaces = makeSurfaces()

function findSurface({ surfaces, links }, x, z, y, reach, from, clearance) {
  let result = null
  for (const surface of surfaces) {
    if (from && surface !== from && !links.get(from)?.has(surface)) continue
    if (!surface.contains(x, z, clearance)) continue
    const height = surface.height(z)
    const difference = Math.abs(height - y)
    if (difference <= reach && (!result || difference < reach)) {
      reach = difference
      result = { surface, y: height }
    }
  }
  return result
}

function makeNavigation(THREE, updateMatrix, worldPoint, entrance, native) {
  const surfaces = native ? makeSurfaces(native) : legacySurfaces
  const floorY = native?.floorY || FLOOR_Y
  const local = new THREE.Vector3()
  const lastRestMatrix = new THREE.Matrix4()
  let restSpots
  function getRestSpots() {
    const { matrix } = updateMatrix()
    if (!restSpots || !lastRestMatrix.equals(matrix)) {
      lastRestMatrix.copy(matrix)
      restSpots = (native?.restSpots || REST_SPOTS).map(spot => {
        const [x, z] = spot.entry
        const entry = worldPoint(x, floorY[spot.floor], z)
        const forward = new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw)).transformDirection(matrix)
        return { id: spot.id, kind: spot.kind, name: spot.name, entry, exit: entry.clone(),
          position: worldPoint(...spot.position), yaw: Math.atan2(forward.x, forward.z) }
      })
    }
    return restSpots
  }
  function sample(x, z, _bounds, currentY) {
    if (![x, z].every(Number.isFinite)) return null
    const { inverse, matrix } = updateMatrix()
    const hasY = Number.isFinite(currentY)
    local.set(x, hasY ? currentY : matrix.elements[13], z).applyMatrix4(inverse)
    const match = findSurface(surfaces, local.x, local.z, hasY ? local.y : floorY[0], hasY ? .38 : Infinity)
    return match ? worldPoint(local.x, match.y, local.z).y : null
  }
  function sampleMove(x, z, from) {
    if (![x, z, from?.x, from?.y, from?.z].every(Number.isFinite)) return null
    const { inverse } = updateMatrix()
    local.set(from.x, from.y, from.z).applyMatrix4(inverse)
    const px = local.x, pz = local.z
    let match = findSurface(surfaces, px, pz, local.y, .03, undefined, -Infinity)
    if (!match) return null
    local.set(x, from.y, z).applyMatrix4(inverse)
    const dx = local.x - px, dz = local.z - pz
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / .08))
    // A leaf swinging toward the avatar can briefly overlap their footprint.
    // Let them step away from the leaf without permitting movement deeper into it.
    let minimum = RADIUS
    if (native && match.surface.level !== undefined) minimum = Math.min(minimum, native.doorClearance(match.surface.level, px, pz))
    for (let i = 1; i <= steps; i++) {
      const nextX = px + dx * i / steps, nextZ = pz + dz * i / steps
      match = findSurface(surfaces, nextX, nextZ, match.y, .21, match.surface, Math.min(RADIUS, minimum + EPSILON))
      if (!match) return null
      if (minimum < RADIUS) minimum = match.surface.level === undefined ? RADIUS :
        Math.min(RADIUS, native.doorClearance(match.surface.level, nextX, nextZ))
    }
    return worldPoint(local.x, match.y, local.z).y
  }
  function spawn() {
    const { inside, yaw } = entrance(ENTRANCES[0])
    return { x: inside.x, y: inside.y, z: inside.z, yaw }
  }
  return { sample, sampleMove, spawn, get restSpots() { return getRestSpots() } }
}

// The uploaded asset merges indexed box geometry by material. Identify the
// two panes, four handles and central stile of each doorway by their bounds.
function movingPart(kind, x, y, z) {
  for (const door of ENTRANCES) {
    if (Math.abs(x - door.x) > (door.right - door.left) / 2 || Math.abs(z - door.z) > .19) continue
    const centerZ = door.z + door.inward * .083
    const side = x < door.x ? -1 : 1
    const equal = (a, b) => Math.abs(a - b) < .002
    if (kind === 'stile' && equal(x, door.x) && equal(y, 1.544) && equal(z, centerZ)) return [door.id, -1]
    if (kind === 'glass' && equal(Math.abs(x - door.x), (door.right - door.left) / 4) &&
        equal(y, 1.544) && equal(z, centerZ)) return [door.id, side]
    if (kind === 'handles' && equal(Math.abs(x - door.x), .115) && equal(y, 1.22) &&
        equal(Math.abs(z - centerZ), .085)) return [door.id, side]
  }
  return null
}

function splitBatch(mesh, kind) {
  const geometry = mesh?.geometry, index = geometry?.index, position = geometry?.attributes.position
  if (!index || !position || position.count % 24 || index.count !== position.count * 1.5 ||
      Object.values(geometry.attributes).some(attribute => attribute.isInterleavedBufferAttribute)) return null
  const fixed = [], moving = new Map()
  for (let base = 0; base < position.count; base += 24) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (let j = base; j < base + 24; j++) {
      const x = position.getX(j), y = position.getY(j), z = position.getZ(j)
      x0 = Math.min(x0, x); x1 = Math.max(x1, x)
      y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      z0 = Math.min(z0, z); z1 = Math.max(z1, z)
    }
    const part = movingPart(kind, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    const key = part?.join(':')
    if (key && !moving.has(key)) moving.set(key, [])
    const target = key ? moving.get(key) : fixed
    for (let i = base * 1.5; i < base * 1.5 + 36; i++) {
      const vertex = index.getX(i)
      if (vertex < base || vertex >= base + 24) return null
      target.push(vertex)
    }
  }
  for (const door of ENTRANCES) {
    if ((moving.get(door.id + ':-1')?.length || 0) !== (kind === 'handles' ? 72 : 36) ||
        (moving.get(door.id + ':1')?.length || 0) !== (kind === 'handles' ? 72 : kind === 'glass' ? 36 : 0)) return null
  }
  return { mesh, fixed, moving }
}

function takeGeometry(THREE, source, indices, origin) {
  const geometry = new THREE.BufferGeometry(), selected = new Map(), originals = []
  geometry.setIndex(indices.map(i => {
    if (!selected.has(i)) {
      selected.set(i, originals.length)
      originals.push(i)
    }
    return selected.get(i)
  }))
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const { array, itemSize, normalized } = attribute
    const values = new array.constructor(originals.length * itemSize)
    for (let i = 0; i < originals.length; i++) {
      const start = originals[i] * itemSize
      for (let j = 0; j < itemSize; j++) values[i * itemSize + j] = array[start + j]
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize, normalized))
  }
  if (origin) geometry.translate(-origin.x, -origin.y, -origin.z)
  return geometry
}

function prepareDoors(THREE, facade) {
  const batches = FACADES.map(([material, kind]) => splitBatch(
    facade.children.find(child => child.isMesh && child.material?.name === material), kind))
  if (batches.some(batch => !batch)) return null
  const doors = new Map(), replaced = [], added = []
  for (const door of ENTRANCES) {
    const pivots = []
    for (const side of [-1, 1]) {
      const hinge = new THREE.Group()
      hinge.name = 'Courtyard door ' + door.id + (side === -1 ? ' left' : ' right')
      hinge.position.set(side === -1 ? door.left + .065 : door.right - .065, 0, door.z + .083 * door.inward)
      for (const { mesh, moving } of batches) {
        const indices = moving.get(door.id + ':' + side)
        if (!indices) continue
        const part = new THREE.Mesh(takeGeometry(THREE, mesh.geometry, indices, hinge.position), mesh.material)
        part.name = mesh.material.name
        part.receiveShadow = mesh.receiveShadow
        hinge.add(part)
        added.push(part.geometry)
      }
      facade.add(hinge)
      pivots.push({ hinge, angle: door.inward * side * Math.PI * .47 })
    }
    doors.set(door.id, pivots)
  }
  for (const { mesh, fixed } of batches) {
    replaced.push({ mesh, original: mesh.geometry })
    mesh.geometry = takeGeometry(THREE, mesh.geometry, fixed)
    added.push(mesh.geometry)
  }
  return { doors, replaced, added }
}

function createCourtyardInterior({ THREE, model }) {
  const floor = model?.getObjectByName('F1')
  const facade = floor?.children.find(child => child.name === 'Exterior')
  if (!facade) return null
  const matrix = new THREE.Matrix4(), inverse = new THREE.Matrix4()
  let motion = null
  function updateMatrix() {
    floor.updateWorldMatrix(true, false)
    if (!matrix.equals(floor.matrixWorld)) {
      matrix.copy(floor.matrixWorld)
      inverse.copy(matrix).invert()
    }
    return { matrix, inverse }
  }
  function worldPoint(x, y, z) {
    return new THREE.Vector3(x, y, z).applyMatrix4(matrix)
  }
  const native = createNativeCourtyard({ THREE, model, floor, updateMatrix, worldPoint, radius: RADIUS })
  function entrance(door) {
    updateMatrix()
    const { id, label, x, z, inward } = door
    const forward = new THREE.Vector3(0, 0, inward).transformDirection(matrix)
    const height = native?.floorY[0] ?? FLOOR_Y[0]
    return {
      id, label, forward, yaw: Math.atan2(forward.x, forward.z),
      outside: worldPoint(x, 0, z - inward * 1.50),
      threshold: worldPoint(x, height, z + inward * .083),
      inside: worldPoint(x, height, z + inward * 1.20),
      ...(native ? { seconds: native.entranceClip(id) } : {})
    }
  }
  function setDoorProgress(id, progress) {
    if (!Number.isFinite(progress) || !ENTRANCES.some(door => door.id === id)) return false
    const t = Math.min(1, Math.max(0, progress))
    if (native) return native.setEntranceProgress(id, t)
    if (!motion && t === 0) return true
    if (!motion) motion = prepareDoors(THREE, facade)
    if (!motion) return false
    for (const { hinge, angle } of motion.doors.get(id)) hinge.rotation.y = angle * t
    return true
  }
  function resetDoors() {
    native?.resetDoors()
    if (!motion) return
    for (const pivots of motion.doors.values()) for (const { hinge } of pivots) hinge.rotation.y = 0
  }
  function dispose() {
    native?.resetDoors()
    if (!motion) return
    for (const pivots of motion.doors.values()) for (const { hinge } of pivots) hinge.removeFromParent()
    for (const { mesh, original } of motion.replaced) mesh.geometry = original
    for (const geometry of motion.added) geometry.dispose()
    motion = null
  }
  const navigation = makeNavigation(THREE, updateMatrix, worldPoint, entrance, native)
  return {
    getEntrances: () => ENTRANCES.map(entrance),
    getLiftLandings: () => native?.getLiftLandings() || [],
    getRoomDoor: position => native?.getRoomDoor(position, navigation) || null,
    interactRoomDoor: (id, position) => native?.interactRoomDoor(id, position, navigation) || false,
    update: (dt, position) => native?.update(dt, position) || false,
    navigation,
    setDoorProgress,
    setDoorOpen: (id, open) => setDoorProgress(id, open ? 1 : 0),
    resetDoors,
    dispose
  }
}

module.exports = { createCourtyardInterior }
