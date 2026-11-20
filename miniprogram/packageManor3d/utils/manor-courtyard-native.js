// Revised GLB: the root describes its floor plans and links native clips to
// the moving door nodes. All navigation coordinates are in the model frame.
const SHAFT = [8.67, 10.68, .52, 2.48]
const DOOR_REACH = 1.55
const REST_SPOTS = [
  { id: 'living-sofa-left', kind: 'sit', name: '客厅沙发', floor: 0, position: [1.97, .54, 10.08], entry: [1.97, 10.73], yaw: 0 },
  { id: 'living-sofa-right', kind: 'sit', name: '客厅沙发', floor: 0, position: [3.88, .54, 10.08], entry: [3.88, 10.73], yaw: 0 },
  { id: 'guest-bedroom-bed', kind: 'lie', name: '客房床', floor: 0, position: [14.49, .73, 2.20], entry: [14.49, 3.55], yaw: 0 },
  { id: 'second-bedroom-bed', kind: 'lie', name: '次卧床', floor: 1, position: [1.965, 4.34, 2.70], entry: [3.12, 2.70], yaw: 0 },
  { id: 'main-bedroom-bed', kind: 'lie', name: '主卧床', floor: 1, position: [2.10, 4.34, 9.85], entry: [3.53, 9.85], yaw: 0 }
]

function metadataDoor(door, floors) {
  return typeof door?.id === 'string' && floors.some(floor => floor.id === door.level) &&
    (door.axis === 'h' || door.axis === 'v') && Number.isFinite(door.wall) &&
    door.opening?.length === 2 && door.opening.every(Number.isFinite) && door.opening[0] < door.opening[1] &&
    Number.isFinite(door.clearWidth) && door.clearWidth > 0 && door.center?.length === 3 && door.center.every(Number.isFinite)
}

function appendWall(boxes, axis, box, doors) {
  const [normal0, normal1, start, end] = axis === 'v' ? box : [box[2], box[3], box[0], box[1]]
  const holes = doors.filter(d => d.axis === axis && d.wall >= normal0 - .01 && d.wall <= normal1 + .01 &&
    d.opening[1] > start && d.opening[0] < end).sort((a, b) => a.opening[0] - b.opening[0])
  const span = (a, b) => {
    if (b - a > .001) boxes.push(axis === 'v' ? [normal0, normal1, a, b] : [a, b, normal0, normal1])
  }
  let cursor = start
  for (const door of holes) {
    const [low, high] = door.opening
    const gap = door.mode === 'track' ? .032 : Math.max(0, (high - low - door.clearWidth) / 2)
    span(cursor, Math.min(end, low + gap))
    cursor = Math.max(cursor, Math.min(end, high - gap))
  }
  span(cursor, end)
}

function makeColliders(THREE, node, relativeTo) {
  const inverse = new THREE.Matrix4(), bounds = new THREE.Box3(), point = new THREE.Vector3()
  node.updateWorldMatrix(true, true)
  inverse.copy(relativeTo.matrixWorld).invert()
  node.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry) return
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index
    const matrix = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld)
    for (let i = 0; position && i < (index?.count ?? position.count); i++) {
      bounds.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix))
    }
  })
  if (bounds.isEmpty()) return null
  return { box: [bounds.min.x, bounds.max.x, bounds.min.z, bounds.max.z], height: bounds.max.y }
}

function floorCollision(THREE, node, frame, plan, doors) {
  const walls = [], furniture = []
  const landing = doors.find(door => door.mode === 'lift')
  const [landingStart, landingEnd] = landing?.opening || [0, 0]
  // The two stair flights and the lift shaft share the central core. The
  // opening through its west wall is only crossed by the lift controller.
  walls.push([8.425, 8.575, 0, landingStart], [8.425, 8.575, landingEnd, 6.6],
    [11.425, 11.575, 0, 6.6], [8.5, 8.98, 6.525, 6.675],
    [11.02, 11.5, 6.525, 6.675], SHAFT)
  if (plan.terraceEdge > plan.depth) {
    appendWall(walls, 'h', [0, plan.width, plan.depth - .22, plan.depth], doors)
  }
  node.traverse(item => {
    if (item.userData.kind !== 'wall' && item.userData.kind !== 'furniture') return
    const bounds = makeColliders(THREE, item, frame)
    if (!bounds || bounds.height < plan.height + .11) return
    if (item.userData.kind === 'wall') {
      const [x0, x1, z0, z1] = bounds.box
      appendWall(walls, x1 - x0 < z1 - z0 ? 'v' : 'h', bounds.box, doors)
    } else furniture.push(bounds.box)
  })
  return { walls, furniture }
}

function clipPlayer(clip, nodes) {
  if (!clip || !(clip.duration > 0)) return null
  const tracks = []
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const node = nodes.get(track.name.slice(0, dot)), property = track.name.slice(dot + 1)
    if (!node || property !== 'position' && property !== 'quaternion') return null
    tracks.push({ interpolate: track.createInterpolant(), target: node[property] })
  }
  if (!tracks.length) return null
  return { duration: clip.duration, apply(t) {
    for (const { interpolate, target } of tracks) target.fromArray(interpolate.evaluate(t * clip.duration))
  } }
}

function nativeDoor(THREE, root, data, clips) {
  const nodes = new Map()
  for (const name of data.motionNodes || []) {
    const node = root.getObjectByName(name)
    if (node?.userData.doorId !== data.id) return null
    nodes.set(name, node)
  }
  const open = clipPlayer(clips.get(data.open), nodes), close = clipPlayer(clips.get(data.close), nodes)
  if (!open || !close) return null
  const mounted = root.children.find(child => child.userData.level === data.level)?.children.find(child =>
    child.userData.kind === 'operableDoor' && child.userData.doorId === data.id)
  const leaves = []
  mounted?.traverse(node => {
    const p = node.userData.colliderLocal
    if (p?.length === 6 && p.every(Number.isFinite)) leaves.push({ node, inverse: new THREE.Matrix4(), box: [p[0], p[3], p[2], p[5]] })
  })
  if (!leaves.length) return null
  return { data, leaves, open, close, progress: 0, target: null }
}

function createNativeCourtyard({ THREE, model, floor, updateMatrix, worldPoint, radius }) {
  const root = floor.parent
  const { floors, doors, lift } = root?.userData || {}
  if (!Array.isArray(doors) || !Array.isArray(floors) || floors.length !== 3 || !floors.every((plan, i) =>
    plan.id === i + 1 && [plan.height, plan.width, plan.depth, plan.terraceEdge].every(Number.isFinite))) return null
  const plans = floors.map(plan => root.getObjectByName(plan.node))
  if (plans.some(node => !node)) return null
  const definitions = doors.filter(item => metadataDoor(item, floors))
  const clips = new Map(model.animations.map(clip => [clip.name, clip]))
  const all = new Map()
  for (const door of definitions) {
    if (door.mode === 'lift') continue
    const runner = nativeDoor(THREE, root, door, clips)
    if (runner) all.set(door.id, runner)
  }
  if (!all.has('D11') || !all.has('D12')) return null
  const rooms = [...all.values()].filter(({ data }) => data.id !== 'D11' && data.id !== 'D12')
  const levelCollision = plans.map((node, i) => floorCollision(THREE, node, floor, floors[i], definitions.filter(d => d.level === i + 1)))
  const floorY = floors.map(plan => plan.height)
  const local = new THREE.Vector3(), leafPoint = new THREE.Vector3()
  function pose(runner, progress, opening = true) {
    const { inverse } = updateMatrix()
    if (opening) runner.open.apply(progress)
    else runner.close.apply(1 - progress)
    runner.progress = progress
    for (const leaf of runner.leaves) {
      leaf.node.updateWorldMatrix(true, false)
      leaf.inverse.multiplyMatrices(inverse, leaf.node.matrixWorld).invert()
    }
  }
  for (const runner of all.values()) pose(runner, 0)

  function clearance(runner, x, z) {
    const { axis, opening, wall, level } = runner.data
    const along = axis === 'h' ? x : z, across = axis === 'h' ? z : x
    if (Math.abs(across - wall) > 2.1 || along < opening[0] - 1.9 || along > opening[1] + 1.9) return Infinity
    let distance = Infinity
    for (const leaf of runner.leaves) {
      leafPoint.set(x, floorY[level - 1] + .7, z).applyMatrix4(leaf.inverse)
      const [x0, x1, z0, z1] = leaf.box
      const dx = Math.max(x0 - leafPoint.x, leafPoint.x - x1)
      const dz = Math.max(z0 - leafPoint.z, leafPoint.z - z1)
      distance = Math.min(distance, Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0))
    }
    return distance
  }
  const byFloor = floors.map(({ id }) => [...all.values()].filter(runner => runner.data.level === id))
  function nearby(position, navigation, id) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
    const { inverse } = updateMatrix()
    local.copy(position).applyMatrix4(inverse)
    let nearest = null, limit = DOOR_REACH
    for (const runner of rooms) {
      const d = runner.data
      if (id && id !== d.id || Math.abs(local.y - floorY[d.level - 1]) > .38) continue
      const horizontal = d.axis === 'h'
      const center = d.mode === 'track' ? d.opening[0] + d.clearWidth / 2 + .032 : d.center[horizontal ? 0 : 2]
      const along = horizontal ? local.x : local.z, normal = horizontal ? local.z : local.x
      const distance = Math.hypot(along - center, normal - d.wall)
      if (distance > limit) continue
      const sign = normal < d.wall ? -1 : 1
      const offset = Math.max(.45, radius + .235)
      const approach = d.wall + sign * offset
      const path = worldPoint(horizontal ? center : approach, floorY[d.level - 1], horizontal ? approach : center)
      if (!Number.isFinite(navigation.sampleMove(path.x, path.z, position))) continue
      nearest = runner
      limit = distance
    }
    return nearest
  }
  function setEntranceProgress(id, progress) {
    const runner = all.get(id === 'north' ? 'D11' : id === 'south' ? 'D12' : '')
    if (!runner) return false
    if (progress !== runner.progress) pose(runner, progress, progress > runner.progress)
    return true
  }
  function getLiftLandings() {
    if (!root.getObjectByName(lift?.car)) return []
    const { matrix } = updateMatrix()
    const forward = new THREE.Vector3(1, 0, 0).transformDirection(matrix)
    const yaw = Math.atan2(forward.x, forward.z)
    return definitions.filter(d => d.mode === 'lift').map(d => ({ level: d.level,
      approach: worldPoint(d.wall - .55, floorY[d.level - 1], d.center[2]),
      cabin: worldPoint(9.7, floorY[d.level - 1], d.center[2]), yaw }))
  }
  return {
    floors, floorY, levelCollision, restSpots: REST_SPOTS, getLiftLandings,
    doorClearance(level, x, z) {
      let distance = Infinity
      for (const runner of byFloor[level]) distance = Math.min(distance, clearance(runner, x, z))
      return distance
    },
    entranceClip: id => all.get(id === 'north' ? 'D11' : 'D12').open.duration,
    setEntranceProgress,
    getRoomDoor(position, navigation) {
      const door = nearby(position, navigation)
      return door ? { id: door.data.id, label: door.data.title, open: door.progress === 1, busy: door.target !== null } : null
    },
    interactRoomDoor(id, position, navigation) {
      const door = nearby(position, navigation, id)
      if (!door || door.target !== null) return false
      door.target = door.progress === 1 ? 0 : 1
      return true
    },
    update(dt, position) {
      if (!Number.isFinite(dt) || dt <= 0) return false
      const { inverse } = updateMatrix()
      if (position) local.copy(position).applyMatrix4(inverse)
      let changed = false
      for (const door of rooms) {
        if (door.target === null) continue
        const before = door.progress
        if (door.target === before) { door.target = null; continue }
        const opening = door.target > before
        const progress = opening ? Math.min(1, before + dt / door.open.duration) : Math.max(0, before - dt / door.close.duration)
        pose(door, progress, opening)
        if (!opening && position && Math.abs(local.y - floorY[door.data.level - 1]) < 1.5 && clearance(door, local.x, local.z) < radius) {
          pose(door, before, opening)
          // Reopen if somebody steps into a closing leaf's path.
          door.target = 1
          continue
        }
        changed = changed || before !== progress
        if (progress === door.target) door.target = null
      }
      return changed
    },
    resetDoors() {
      for (const door of all.values()) {
        door.target = null
        if (door.progress !== 0) pose(door, 0, false)
      }
    }
  }
}

module.exports = { createNativeCourtyard }
