const FLOOR_HEIGHT = .03
const PLAYER_RADIUS = .3
const COLLISION_STEP = .12
const HALL_EDGE = 6.85
const DOOR_REACH = 1.45
const DOOR_APPROACH_Z = 12.5

// The first-floor finish in the tower GLB is a south lobby joined to a
// narrower public hall by the stair and service rooms.
function isLobbyFloor(x, z, thresholdZ) {
  const insideLobby = Math.abs(x) <= 4.3 - PLAYER_RADIUS && z >= HALL_EDGE + PLAYER_RADIUS &&
    z <= thresholdZ - PLAYER_RADIUS
  const insideHall = x >= -2.1 + PLAYER_RADIUS && x <= .96 - PLAYER_RADIUS &&
    z >= 1.84 + PLAYER_RADIUS && z <= HALL_EDGE + PLAYER_RADIUS
  const nearPlanter = Math.abs(Math.abs(x) - 3.57) < .34 + PLAYER_RADIUS &&
    Math.abs(z - 9.4) < .32 + PLAYER_RADIUS
  return (insideLobby || insideHall) && !nearPlanter
}

function createTowerInterior({ THREE, model }) {
  const lobby = model.getObjectByName('Tower lobby')
  const leaves = ['SouthEntry_L', 'SouthEntry_R'].map(name => model.getObjectByName(name))
  if (!lobby || leaves.some(leaf => !Number.isFinite(leaf?.userData.slideX))) return null

  model.updateWorldMatrix(true, true)
  const inverse = model.matrixWorld.clone().invert()
  const scratch = new THREE.Vector3()
  const world = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(model.matrixWorld)
  const [left, right] = leaves.map(leaf => leaf.position.clone())
  const centerX = (left.x + right.x) / 2
  const thresholdZ = (left.z + right.z) / 2
  const local = point => scratch.set(point.x, point.y, point.z).applyMatrix4(inverse)
  const inside = world(centerX, FLOOR_HEIGHT, thresholdZ - DOOR_REACH)
  const outside = world(centerX, FLOOR_HEIGHT, Math.max(DOOR_APPROACH_Z, thresholdZ + DOOR_REACH))
  const threshold = world(centerX, FLOOR_HEIGHT, thresholdZ)
  const yaw = Math.atan2(inside.x - outside.x, inside.z - outside.z)

  function sample(x, z, _bounds, y = inside.y) {
    if (![x, y, z].every(Number.isFinite)) return null
    const point = local({ x, y, z })
    return Math.abs(point.y - FLOOR_HEIGHT) <= .38 && isLobbyFloor(point.x, point.z, thresholdZ) ? inside.y : null
  }

  function sampleMove(x, z, from) {
    if (sample(from?.x, from?.z, null, from?.y) === null || ![x, z].every(Number.isFinite)) return null
    const dx = x - from.x, dz = z - from.z
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / COLLISION_STEP))
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps
      if (sample(from.x + dx * fraction, from.z + dz * fraction, null, from.y) === null) return null
    }
    return inside.y
  }

  return {
    navigation: { sample, sampleMove, spawn: () => inside.clone() },
    doors: [{ id: 'main', label: '住宅楼正门', outside, threshold, inside, yaw }],
    setDoorProgress(id, progress) {
      if (id !== 'main') return false
      leaves[0].position.x = left.x + leaves[0].userData.slideX * progress
      leaves[1].position.x = right.x + leaves[1].userData.slideX * progress
      return true
    },
    setOccupied(occupied) { lobby.visible = occupied },
    dispose() { lobby.visible = false }
  }
}

module.exports = { createTowerInterior }
