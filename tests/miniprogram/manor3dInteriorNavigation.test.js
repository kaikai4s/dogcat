const test = require('node:test')
const assert = require('node:assert/strict')
const { createManorInteriorNavigation, FLOORS, RAMPS } = require('../../miniprogram/packageManor3d/utils/manor-interior-navigation')

const metadata = {
  model: 'manor-villa-interior.glb',
  anchors: {
    FrontDoor: { position: [2.7015, .406, 3.1112], yaw: 0 },
    InteriorSpawn: { position: [2.7015, .411, 1.9712], yaw: Math.PI }
  },
  frontDoorOpening: { enterDirection: [0, 0, -1] }
}

const origin = { x: 54, y: 4.1, z: 88 }
const EXPORT_OFFSET = { x: 1.4215329, y: .00595, z: -.44875 }
const world = (x, y = .405, z = 0) => ({
  x: origin.x + EXPORT_OFFSET.x + x,
  y: origin.y + EXPORT_OFFSET.y + y,
  z: origin.z + EXPORT_OFFSET.z + z
})

test('interior anchors are translated to the villa world origin and spawn is walkable', () => {
  const navigation = createManorInteriorNavigation({ metadata, origin })
  assert.deepEqual(navigation.entry(), {
    x: origin.x + 2.7015,
    y: origin.y + .406,
    z: origin.z + 3.1112
  })
  const spawn = navigation.spawn()
  assert.ok(spawn)
  assert.equal(navigation.sample(spawn.x, spawn.z, null, spawn.y), spawn.y)
  assert.equal(spawn.x, origin.x + 2.7015)
  assert.equal(spawn.z, origin.z + 1.9712)
  assert.equal(spawn.yaw, Math.PI)
})

test('outside entry follows the door direction and is separated from the interior marker', () => {
  const navigation = createManorInteriorNavigation({ metadata, origin })
  const entry = navigation.entry()
  const outside = navigation.outsideEntry()
  assert.equal(outside.x, entry.x)
  assert.ok(outside.z > entry.z)
  assert.ok(Math.abs(outside.z - entry.z - 3.1) < 1e-9)
})

test('furniture collision expands by the player radius instead of shrinking the obstacle', () => {
  const navigation = createManorInteriorNavigation({ metadata, origin })
  const insideFurnitureEdge = world(-.50, .405, 1.8)
  const outsideFurnitureEdge = world(-.32, .405, 1.8)
  assert.equal(navigation.sample(insideFurnitureEdge.x, insideFurnitureEdge.z, null, insideFurnitureEdge.y), null)
  assert.ok(Number.isFinite(navigation.sample(outsideFurnitureEdge.x, outsideFurnitureEdge.z, null, outsideFurnitureEdge.y)))
})

test('the exported floor and ramp layout exposes both levels and continuous stair heights', () => {
  const navigation = createManorInteriorNavigation({ metadata, origin })
  assert.ok(FLOORS.some(floor => floor.level === 1))
  assert.ok(FLOORS.some(floor => floor.level === 2))
  assert.ok(RAMPS.length >= 2)
  const ramp = RAMPS[0]
  const low = world((ramp.minX + ramp.maxX) / 2, .405, ramp.maxZ - .4)
  const high = world((ramp.minX + ramp.maxX) / 2, 3.43, ramp.minZ + .4)
  const lowY = navigation.sample(low.x, low.z, null, low.y)
  const highY = navigation.sample(high.x, high.z, null, high.y)
  assert.ok(Number.isFinite(lowY) && Number.isFinite(highY))
  assert.ok(highY > lowY)
})

test('rest spots retain their furniture type, floor and clear exit positions', async () => {
  const navigation = await revisedNavigation()
  const bed = navigation.restSpots.find(spot => spot.kind === 'lie')
  const chair = navigation.restSpots.find(spot => spot.id === 'chair-0')
  assert.ok(bed && chair)
  const bedCenter = world(5.235, 3.43, -1.84)
  const chairCenter = world(-8.755, 2.69, 2.105)
  assert.ok(Math.hypot(bed.position.x - bedCenter.x, bed.position.y - bedCenter.y, bed.position.z - bedCenter.z) < 1e-9)
  assert.ok(Math.hypot(chair.position.x - chairCenter.x, chair.position.y - chairCenter.y, chair.position.z - chairCenter.z) < 1e-9)
  assert.ok(Number.isFinite(navigation.sample(bed.entry.x, bed.entry.z, null, bed.entry.y)))
  assert.ok(Number.isFinite(navigation.sample(chair.entry.x, chair.entry.z, null, chair.entry.y)))
  assert.equal(navigation.sample(bed.position.x, bed.position.z, null, bed.position.y), null)
  assert.equal(navigation.sample(chair.position.x, chair.position.z, null, chair.position.y), null)
})

async function revisedNavigation() {
  const { VILLA_LAYOUT, ELEVATOR } = await import('../../tools/manor_villa_interior/villa-layout.js')
  return createManorInteriorNavigation({
    metadata, origin, layout: { ...VILLA_LAYOUT, offset: EXPORT_OFFSET, elevator: ELEVATOR }
  })
}

function traverse(navigation, start, end) {
  const steps = Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / .19)
  let point = start
  for (let i = 1; i <= steps; i++) {
    const x = start.x + (end.x - start.x) * i / steps
    const z = start.z + (end.z - start.z) * i / steps
    const y = navigation.sampleMove(x, z, point)
    assert.notEqual(y, null, 'path blocked near ' + (x - origin.x - EXPORT_OFFSET.x).toFixed(3) +
      ', ' + (z - origin.z - EXPORT_OFFSET.z).toFixed(3))
    assert.ok(Math.abs(y - point.y) <= .33)
    point = { x, y, z }
  }
  assert.ok(Math.abs(point.y - end.y) < 1e-6)
  return point
}

test('the villa is walkable from the entrance to the elevator and from its upper landing into the study and back', async () => {
  const navigation = await revisedNavigation()
  const [lower, upper] = navigation.elevator.landings
  const entrance = [navigation.spawn(), world(1.28, .405, 3.15), world(-5, .405, 3.15), lower]
  for (let i = 1; i < entrance.length; i++) traverse(navigation, entrance[i - 1], entrance[i])
  const path = [
    upper,
    world(-3.70, 3.43, .95),
    world(-3.70, 3.43, -2.28),
    world(-6, 3.43, -2.28),
    world(-8.85, 2.69, -2.28),
    world(-8.85, 2.69, 1.26)
  ]
  for (let i = 1; i < path.length; i++) traverse(navigation, path[i - 1], path[i])
  for (let i = path.length - 1; i > 0; i--) traverse(navigation, path[i], path[i - 1])
  const chairApproach = path.at(-1)
  const chair = world(-8.85, 2.69, 1.56)
  assert.equal(navigation.sampleMove(chair.x, chair.z, chairApproach), null)
})

test('connected floor slabs and the projecting window merge without a collision gap', async () => {
  const navigation = await revisedNavigation()
  traverse(navigation, world(2.53, .405, 3.20), world(3.13, .405, 3.20))
  traverse(navigation, world(-6.1, .405, 1.95), world(-6.85, .405, 1.95))
  traverse(navigation, world(5.74, .405, 4.58), world(5.74, .405, 5.18))
  traverse(navigation, world(5.92, 3.43, 4.58), world(5.92, 3.43, 5.05))
  const beyondWindowWall = world(6.94, .405, 5.21)
  assert.equal(navigation.sample(beyondWindowWall.x, beyondWindowWall.z, null, beyondWindowWall.y), null)
})

test('players cannot enter the shaft, cross the study stair rail, or bypass the split-level drop', async () => {
  const navigation = await revisedNavigation()
  for (const landing of navigation.elevator.landings) {
    const shaft = { ...landing, z: navigation.elevator.cabinZ }
    assert.equal(navigation.sampleMove(shaft.x, shaft.z, landing), null)
    assert.equal(navigation.sample(shaft.x, shaft.z, null, shaft.y), null)
  }

  const besideSplitSteps = world(-7.18, 2.69, -.98)
  const splitSteps = world(-7.18, 2.69, -1.995)
  assert.ok(navigation.sample(splitSteps.x, splitSteps.z, null, splitSteps.y) > splitSteps.y)
  assert.equal(navigation.sampleMove(splitSteps.x, splitSteps.z, besideSplitSteps), null)

  const mainUpper = world(-6.08, 3.43, -.2)
  const westUpper = world(-6.83, 2.69, -.2)
  assert.equal(navigation.sampleMove(westUpper.x, westUpper.z, mainUpper), null)
})
