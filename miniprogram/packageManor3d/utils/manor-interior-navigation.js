const PLAYER_RADIUS = 0.30
const EPSILON = 1e-5
const MAX_STEP_HEIGHT = .33
const COLLISION_STEP = .08
// The interior exporter uses the same floor-center origin as the exterior
// villa, so its source layout is offset by the normalization transform.
const EXPORT_OFFSET = Object.freeze({ x: 1.4215329, y: .00595, z: -.44875 })

// Fallback for the original interior GLB. Revised assets embed their own layout.
const FLOORS = Object.freeze([
  { minX: -6.46, maxX: 6.46, minZ: -3.60, maxZ: 3.56, y: .405, level: 1 },
  { minX: 6.46, maxX: 7.53, minZ: -4.34, maxZ: 4.93, y: .405, level: 1 },
  { minX: -10.32, maxX: -6.46, minZ: -3.43, maxZ: 3.22, y: .405, level: 1 },
  { minX: -6.46, maxX: -5.40, minZ: -3.60, maxZ: 3.56, y: 3.43, level: 2 },
  { minX: -4.00, maxX: 6.46, minZ: -3.60, maxZ: 3.56, y: 3.43, level: 2 },
  { minX: -5.40, maxX: -4.00, minZ: -3.60, maxZ: -2.80, y: 3.43, level: 2 },
  { minX: -5.40, maxX: -4.00, minZ: .42, maxZ: 3.56, y: 3.43, level: 2 },
  { minX: 6.46, maxX: 7.53, minZ: -4.34, maxZ: 4.93, y: 3.43, level: 2 },
  { minX: -10.32, maxX: -6.46, minZ: -3.43, maxZ: 3.22, y: 2.69, level: 2 }
])

const RAMPS = Object.freeze([
  { minX: -5.40, maxX: -4.00, minZ: -2.80, maxZ: 2.80, fromY: 3.43, toY: .405, level: 1 },
  { minX: -9.64, maxX: -9.02, minZ: -.70, maxZ: 2.25, fromY: 2.69, toY: .405, level: 1 }
])

const OBSTACLES = Object.freeze([
  [-3.65, -.65, 1.14, 2.62, 1], [-3.26, -1.18, -.34, .84, 1],
  [-6.15, -5.72, -.43, 1.56, 1], [-6.15, -5.77, -2.82, -.78, 1],
  [6.72, 7.36, -3.86, -.56, 1], [3.33, 5.83, .43, 1.81, 1],
  [-9.74, -8.09, 1.52, 2.76, 1], [-8.19, -6.91, -.90, .30, 1],
  [4.19, 6.28, -3.13, -1.05, 2], [-4.52, -4.08, -.55, .32, 2],
  [-.30, 2.24, 1.23, 2.58, 2], [.02, 1.77, -.46, .63, 2],
  [-6.16, -5.73, -2.82, .93, 2], [-9.74, -8.12, 1.53, 2.77, 2]
].map(([minX, maxX, minZ, maxZ, level]) => ({ minX, maxX, minZ, maxZ, level })))

const number = value => Number.isFinite(value) ? value : null
const inside = (item, x, z, margin = 0) =>
  x >= item.minX + margin - EPSILON && x <= item.maxX - margin + EPSILON &&
  z >= item.minZ + margin - EPSILON && z <= item.maxZ - margin + EPSILON

function validBounds(item) {
  return item && [item.minX, item.maxX, item.minZ, item.maxZ, item.level].every(Number.isFinite) &&
    item.minX < item.maxX && item.minZ < item.maxZ
}

function modelLayout(data) {
  if (data?.offset && [data.offset.x, data.offset.y, data.offset.z].every(Number.isFinite) &&
    Array.isArray(data.floors) && data.floors.length && data.floors.every(item => validBounds(item) &&
      Number.isFinite(item.y) && (item.outline === undefined ||
      (Array.isArray(item.outline) && item.outline.length >= 3 &&
        item.outline.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))))) &&
    Array.isArray(data.ramps) && data.ramps.every(item => validBounds(item) &&
      [item.fromY, item.toY].every(Number.isFinite) && item.fromY !== item.toY &&
      (item.axis === undefined || item.axis === 'x' || item.axis === 'z')) &&
    Array.isArray(data.obstacles) && data.obstacles.every(validBounds)) return data
  return { offset: EXPORT_OFFSET, floors: FLOORS, ramps: RAMPS, obstacles: OBSTACLES }
}

const cross = (x1, z1, x2, z2) => x1 * z2 - z1 * x2

function edge([x, z], [endX, endZ]) {
  const dx = endX - x, dz = endZ - z
  return { x, z, dx, dz, length: Math.hypot(dx, dz) }
}

function polygonEdges(item) {
  const points = item.outline || [
    [item.minX, item.minZ], [item.maxX, item.minZ],
    [item.maxX, item.maxZ], [item.minX, item.maxZ]
  ]
  return points.map((point, i) => edge(point, points[(i + 1) % points.length]))
    .filter(side => side.length > EPSILON)
}

function insidePolygon(edges, x, z) {
  let side = 0
  for (const line of edges) {
    const distance = cross(line.dx, line.dz, x - line.x, z - line.z) / line.length
    if (Math.abs(distance) <= EPSILON) continue
    const sign = Math.sign(distance)
    if (side && side !== sign) return false
    side = sign
  }
  return true
}

function project(line, x, z) {
  return ((x - line.x) * line.dx + (z - line.z) * line.dz) / (line.length * line.length)
}

function splitLineAtIntersection(line, other, splits) {
  const x = other.x - line.x, z = other.z - line.z
  const denominator = cross(line.dx, line.dz, other.dx, other.dz)
  function add(t) {
    if (t > EPSILON && t < 1 - EPSILON) splits.push(t)
  }
  if (Math.abs(denominator) <= EPSILON) {
    if (Math.abs(cross(line.dx, line.dz, x, z)) <= EPSILON * line.length) {
      add(project(line, other.x, other.z))
      add(project(line, other.x + other.dx, other.z + other.dz))
    }
  } else {
    const u = cross(x, z, line.dx, line.dz) / denominator
    if (u >= -EPSILON && u <= 1 + EPSILON) add(cross(x, z, other.dx, other.dz) / denominator)
  }
}

function openEdge(portal, x, z, line) {
  if (Math.abs(cross(portal.dx, portal.dz, line.dx, line.dz)) > EPSILON * portal.length * line.length ||
    Math.abs(cross(portal.dx, portal.dz, x - portal.x, z - portal.z)) > EPSILON * portal.length) return false
  const t = project(portal, x, z)
  return t >= -EPSILON && t <= 1 + EPSILON
}

function floorRegion(floors, cuts, portals) {
  const polygons = floors.map(item => ({ item, edges: polygonEdges(item) }))
  const contains = (x, z) => polygons.some(({ item, edges }) => inside(item, x, z) && insidePolygon(edges, x, z)) &&
    !cuts.some(item => inside(item, x, z, EPSILON * 2))
  const edges = polygons.flatMap(({ edges }) => edges).concat(cuts.flatMap(polygonEdges))
  const boundaries = []
  // Keep only exposed segments of the combined footprint. Shared slab edges
  // and stair portals have no collision margin across them.
  for (const line of edges) {
    const splits = [0, 1]
    for (const other of edges) if (other !== line) splitLineAtIntersection(line, other, splits)
    for (const portal of portals) splitLineAtIntersection(line, portal, splits)
    splits.sort((a, b) => a - b)
    for (let i = 1; i < splits.length; i++) {
      const start = splits[i - 1], end = splits[i]
      if (end - start <= EPSILON) continue
      const mid = (start + end) / 2
      const x = line.x + line.dx * mid, z = line.z + line.dz * mid
      const dx = -line.dz / line.length * EPSILON * 4
      const dz = line.dx / line.length * EPSILON * 4
      if (contains(x + dx, z + dz) === contains(x - dx, z - dz) ||
        portals.some(portal => openEdge(portal, x, z, line))) continue
      boundaries.push(edge(
        [line.x + line.dx * start, line.z + line.dz * start],
        [line.x + line.dx * end, line.z + line.dz * end]))
    }
  }
  return (x, z) => contains(x, z) && !boundaries.some(line => {
    const t = Math.max(0, Math.min(1, project(line, x, z)))
    const dx = x - line.x - t * line.dx, dz = z - line.z - t * line.dz
    return dx * dx + dz * dz < (PLAYER_RADIUS - EPSILON) ** 2
  })
}

function rampSurface(ramp) {
  const alongX = ramp.axis === 'x'
  const min = alongX ? ramp.minX : ramp.minZ
  const max = alongX ? ramp.maxX : ramp.maxZ
  const minSide = alongX ? ramp.minZ : ramp.minX
  const maxSide = alongX ? ramp.maxZ : ramp.maxX
  const position = (x, z) => alongX ? x : z
  const side = (x, z) => alongX ? z : x
  const portal = (at, y, sign) => ({
    at, y, sign, line: alongX ? edge([at, minSide], [at, maxSide]) : edge([minSide, at], [maxSide, at])
  })
  const ends = [portal(min, ramp.fromY, -1), portal(max, ramp.toY, 1)]
  const onLane = value => value >= minSide + PLAYER_RADIUS - EPSILON && value <= maxSide - PLAYER_RADIUS + EPSILON
  return {
    ramp,
    ends,
    contains(x, z) {
      const along = position(x, z)
      return along >= min - EPSILON && along <= max + EPSILON && onLane(side(x, z))
    },
    height(x, z) {
      const fraction = Math.max(0, Math.min(1, (position(x, z) - min) / (max - min)))
      return ramp.fromY + (ramp.toY - ramp.fromY) * fraction
    },
    connects(floor, from, to) {
      const floorAlong = position(from.x, from.z), rampAlong = position(to.x, to.z)
      return ends.some(({ at, y, sign }) => {
        if (Math.abs(floor.y - y) > EPSILON || (floorAlong - at) * sign < -EPSILON ||
          (rampAlong - at) * sign > EPSILON) return false
        const distance = rampAlong - floorAlong
        const fromSide = side(from.x, from.z), toSide = side(to.x, to.z)
        const fraction = Math.abs(distance) > EPSILON ? (at - floorAlong) / distance : 0
        return onLane(fromSide + (toSide - fromSide) * fraction)
      })
    }
  }
}

function floorSurfaces(floors, ramps, obstacles, elevator) {
  const groups = []
  for (const floor of floors) {
    let group = groups.find(item => item.y === floor.y && item.level === floor.level)
    if (!group) groups.push(group = { y: floor.y, level: floor.level, slabs: [] })
    group.slabs.push(floor)
  }
  return groups.map(({ y, level, slabs }) => {
    // The lowest landing is at the foot of the stairs, not inside the risers.
    const cuts = ramps.filter(({ ramp }) => Math.abs(Math.min(ramp.fromY, ramp.toY) - y) <= EPSILON)
      .map(({ ramp }) => ramp)
    if (elevator?.landings.some(landing => Math.abs(landing.y - y) <= EPSILON)) cuts.push(elevator.bounds)
    const portals = ramps.flatMap(({ ends }) => ends.filter(end => Math.abs(end.y - y) <= EPSILON).map(end => end.line))
    const furniture = obstacles.filter(item => item.level === level &&
      !(item.kind === 'stair' && cuts.some(cut => cut.minX === item.minX && cut.maxX === item.maxX &&
        cut.minZ === item.minZ && cut.maxZ === item.maxZ)))
    const inRegion = floorRegion(slabs, cuts, portals)
    return { y, contains: (x, z) => inRegion(x, z) && !furniture.some(item => inside(item, x, z, -PLAYER_RADIUS)) }
  })
}

function elevatorLayout(lift, floors) {
  const bounds = lift?.bounds
  if (typeof lift?.platformNode !== 'string' || !lift.platformNode || !bounds ||
    ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite) ||
    bounds.maxX - bounds.minX <= 2 * PLAYER_RADIUS || bounds.maxZ - bounds.minZ <= 2 * PLAYER_RADIUS ||
    !Array.isArray(lift.landings) || lift.landings.length !== 2 ||
    !lift.landings.every(landing => landing && [landing.x, landing.y, landing.z, landing.floor].every(Number.isFinite) &&
      landing.x >= bounds.minX + PLAYER_RADIUS && landing.x <= bounds.maxX - PLAYER_RADIUS &&
      landing.z >= bounds.maxZ + PLAYER_RADIUS - EPSILON &&
      floors.some(slab => slab.level === landing.floor && Math.abs(slab.y - landing.y) <= EPSILON))) return null
  const landings = [...lift.landings].sort((a, b) => a.y - b.y)
  if (landings[0].floor === landings[1].floor || landings[1].y - landings[0].y <= MAX_STEP_HEIGHT) return null
  return { ...lift, landings }
}

function localAnchor(metadata, name, fallback) {
  const position = metadata?.anchors?.[name]?.position
  const yaw = metadata?.anchors?.[name]?.yaw
  return Array.isArray(position) && position.length >= 3 && position.slice(0, 3).every(Number.isFinite)
    ? { x: position[0], y: position[1], z: position[2], yaw: Number.isFinite(yaw) ? yaw : (fallback.yaw || 0) }
    : fallback
}

function createManorInteriorNavigation({ metadata, layout, origin = { x: 0, y: 0, z: 0 } } = {}) {
  const originX = number(origin.x) ?? 0, originY = number(origin.y) ?? 0, originZ = number(origin.z) ?? 0
  const { offset, floors, ramps, obstacles, elevator: rawElevator } = modelLayout(layout)
  const elevator = elevatorLayout(rawElevator, floors)
  const groundY = Math.min(...floors.map(item => item.y))
  const elevation = originY + offset.y
  const stairs = ramps.map(rampSurface)
  const surfaces = floorSurfaces(floors, stairs, obstacles, elevator).concat(stairs)
  const frontDoor = localAnchor(metadata, 'FrontDoor', { x: 1.28 + offset.x, y: .40 + offset.y, z: 3.56 + offset.z })
  const interiorSpawn = localAnchor(metadata, 'InteriorSpawn', { x: 1.28 + offset.x, y: groundY + offset.y, z: 2.42 + offset.z })
  const enterDirection = Array.isArray(metadata?.frontDoorOpening?.enterDirection) &&
    metadata.frontDoorOpening.enterDirection.length >= 3
    ? metadata.frontDoorOpening.enterDirection : [0, 0, -1]
  const horizontalLength = Math.hypot(enterDirection[0], enterDirection[2])
  const inward = horizontalLength > EPSILON
    ? { x: enterDirection[0] / horizontalLength, z: enterDirection[2] / horizontalLength }
    : { x: 0, z: -1 }

  function world(local, y = local.y) {
    return { x: originX + local.x, y: originY + y, z: originZ + local.z }
  }

  function local(x, z) {
    return { x: x - originX - offset.x, z: z - originZ - offset.z }
  }

  function layoutPoint({ x, y, z }) {
    return world({ x: x + offset.x, y: y + offset.y, z: z + offset.z })
  }

  function closest(point, preferredY, maxDifference, allow) {
    let closestSurface = null, closestY, difference = maxDifference
    for (const surface of surfaces) {
      const y = surface.ramp ? surface.height(point.x, point.z) : surface.y
      const distance = Math.abs(y - preferredY)
      if (distance <= difference && (!closestSurface || distance < difference) &&
        surface.contains(point.x, point.z) && (!allow || allow(surface))) {
        closestSurface = surface
        closestY = y
        difference = distance
      }
    }
    return closestSurface ? { surface: closestSurface, y: closestY } : null
  }

  function sample(x, z, _villaBounds, currentY) {
    if (![x, z].every(Number.isFinite)) return null
    const hasHeight = Number.isFinite(currentY)
    const result = closest(local(x, z), hasHeight ? currentY - elevation : groundY, hasHeight ? .75 : Infinity)
    return result ? elevation + result.y : null
  }

  function sampleMove(x, z, from) {
    if (![x, z, from?.x, from?.y, from?.z].every(Number.isFinite)) return null
    const start = local(from.x, from.z), end = local(x, z)
    let current = closest(start, from.y - elevation, EPSILON)
    if (!current) return null
    let previous = start
    const dx = end.x - start.x, dz = end.z - start.z
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / COLLISION_STEP))
    for (let step = 1; step <= steps; step++) {
      const next = { x: start.x + dx * step / steps, z: start.z + dz * step / steps }
      const surface = current.surface
      current = closest(next, current.y, MAX_STEP_HEIGHT, candidate => {
        if (surface === candidate) return true
        if (surface.ramp && !candidate.ramp) return surface.connects(candidate, next, previous)
        if (!surface.ramp && candidate.ramp) return candidate.connects(surface, previous, next)
        return false
      })
      if (!current) return null
      previous = next
    }
    return elevation + current.y
  }

  function spawn() {
    const point = world(interiorSpawn)
    const y = sample(point.x, point.z, null, point.y)
    return y === null ? null : { x: point.x, y, z: point.z, yaw: interiorSpawn.yaw }
  }

  function entry() {
    return world(frontDoor)
  }

  function outsideEntry(distance = 3.10) {
    const point = entry()
    return { x: point.x - inward.x * distance, y: point.y, z: point.z - inward.z * distance }
  }

  const lift = elevator && {
    ...elevator,
    landings: elevator.landings.map(landing => ({ ...layoutPoint(landing), floor: landing.floor })),
    cabinZ: originZ + offset.z + (elevator.bounds.minZ + elevator.bounds.maxZ) / 2
  }
  return { sample, sampleMove, spawn, entry, outsideEntry, floors, ramps, obstacles, elevator: lift }
}

module.exports = { createManorInteriorNavigation, FLOORS, RAMPS, OBSTACLES }
