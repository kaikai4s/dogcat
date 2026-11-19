const GROUND_Y = .405
const UPPER_Y = 3.43
const WEST_UPPER_Y = 2.69

// The returns at x=2.83 and x=-6.46 separate the three exterior volumes.
const east = [2.83, 7.53, -4.34, 4.93]
const west = [-10.32, -6.46, -3.43, 3.22]
const westReturn = [-10.18, -7.33, 3.22, 3.93]
const shaft = Object.freeze({ minX: -5.94, maxX: -4.06, minZ: -1.79, maxZ: .03 })
const ELEVATOR = Object.freeze({
  id: 'villa-glass-elevator',
  platformNode: 'VillaElevatorCabin',
  bounds: shaft,
  openingWidth: 1.16,
  landings: Object.freeze([
    Object.freeze({ floor: 1, x: -5, y: GROUND_Y, z: .95 }),
    Object.freeze({ floor: 2, x: -5, y: UPPER_Y, z: .95 })
  ])
})
const studySteps = { minX: -7.86, maxX: -6.46, minZ: -2.62, maxZ: -1.37,
  fromY: WEST_UPPER_Y, toY: UPPER_Y, axis: 'x', level: 2 }

// Match the three projecting window assemblies on the exterior.
const BAYS = {
  eastGround: { x: 5.74, z: 4.93, width: 2.68, faceWidth: 2.10, depth: .70,
    y: .38, height: 2.11, floorY: GROUND_Y, level: 1 },
  eastUpper: { x: 5.92, z: 4.93, width: 1.68, faceWidth: 1.34, depth: .46,
    y: 3.18, height: 2.07, floorY: UPPER_Y, level: 2 },
  westGround: { x: -8.76, z: 3.93, width: 1.74, faceWidth: 1.44, depth: .36,
    y: .39, height: 1.97, floorY: GROUND_Y, level: 1 }
}

function floor([minX, maxX, minZ, maxZ], y, level) {
  return { minX, maxX, minZ, maxZ, y, level }
}

const WEST_STUDY_FLOOR = Object.freeze(floor(west, WEST_UPPER_Y, 2))

function bayFloor({ x, z, width, faceWidth, depth, floorY, level }) {
  const farZ = z + depth
  return { ...floor([x - width / 2, x + width / 2, z, farZ], floorY, level),
    outline: [[x - width / 2, z], [x + width / 2, z],
      [x + faceWidth / 2, farZ], [x - faceWidth / 2, farZ]] }
}

function mainFloor(y, level) {
  return [
    [-6.46, shaft.minX, -3.60, 3.56],
    [shaft.maxX, 2.83, -3.60, 3.56],
    [shaft.minX, shaft.maxX, -3.60, shaft.minZ],
    [shaft.minX, shaft.maxX, shaft.maxZ, 3.56]
  ].map(rect => floor(rect, y, level))
}

const floors = [
  ...mainFloor(GROUND_Y, 1),
  floor(east, GROUND_Y, 1),
  floor(west, GROUND_Y, 1),
  floor(westReturn, GROUND_Y, 1),

  ...mainFloor(UPPER_Y, 2),
  floor(east, UPPER_Y, 2),
  WEST_STUDY_FLOOR,
  floor(westReturn, WEST_UPPER_Y, 2),
  ...Object.values(BAYS).map(bayFloor)
]

const furniture = [
  { minX: -3.65, maxX: -.65, minZ: 1.14, maxZ: 2.62, level: 1, kind: 'sofa' },
  { minX: -3.26, maxX: -1.18, minZ: -.34, maxZ: .84, level: 1, kind: 'coffee' },
  { minX: -6.41, maxX: -5.40, minZ: 2.98, maxZ: 3.56, level: 1, kind: 'fireplace' },
  { minX: 6.72, maxX: 7.36, minZ: -3.86, maxZ: -.56, level: 1, kind: 'kitchen' },
  { minX: 3.33, maxX: 5.83, minZ: .43, maxZ: 1.81, level: 1, kind: 'dining' },
  { minX: -9.05, maxX: -7.45, minZ: 1.92, maxZ: 3.09, level: 1, kind: 'pet' },
  { minX: -10.08, maxX: -9.64, minZ: -.93, maxZ: .52, level: 1, kind: 'shelf' },

  { minX: 4.19, maxX: 6.28, minZ: -3.13, maxZ: -1.05, level: 2, kind: 'bed' },
  { minX: 6.62, maxX: 7.21, minZ: -3.10, maxZ: -2.49, level: 2, kind: 'nightstand' },
  { minX: -.30, maxX: 2.24, minZ: 1.23, maxZ: 2.58, level: 2, kind: 'sofa' },
  { minX: .02, maxX: 1.77, minZ: -.46, maxZ: .63, level: 2, kind: 'coffee' },

  { minX: -9.78, maxX: -7.73, minZ: 2.59, maxZ: 3.40, level: 2, kind: 'desk', room: 'study' },
  { minX: -9.08, maxX: -8.43, minZ: 1.76, maxZ: 2.45, level: 2, kind: 'chair', room: 'study' },
  { minX: -10.19, maxX: -9.77, minZ: -.96, maxZ: .66, level: 2, kind: 'shelf', room: 'study' },
  ...[3.95, 5.21].flatMap(x => [-.26, 1.86].map((z, i) => ({
    minX: x - .29, maxX: x + .29, minZ: z, maxZ: z + .63, level: 1, kind: 'chair', reversed: i === 1
  })))
]

const obstacles = furniture.map(({ minX, maxX, minZ, maxZ, level }) =>
  ({ minX, maxX, minZ, maxZ, level }))

let chairIndex = 0
const restSpots = furniture.filter(item => item.kind === 'bed' || item.kind === 'chair').map(item => {
  const x = (item.minX + item.maxX) / 2
  const z = (item.minZ + item.maxZ) / 2
  const y = item.room === 'study' ? WEST_STUDY_FLOOR.y : item.level === 2 ? UPPER_Y : GROUND_Y
  const yaw = item.kind === 'bed' ? 0 : item.reversed ? Math.PI : 0
  const position = item.kind === 'bed' ? { x, y, z: z + .25 } : { x, y, z }
  const exit = item.kind === 'bed'
    ? { x, y, z: item.maxZ + .74 }
    : { x: x - Math.sin(yaw) * ((item.maxZ - item.minZ) / 2 + .40),
      y, z: z - Math.cos(yaw) * ((item.maxZ - item.minZ) / 2 + .40) }
  const id = item.kind === 'bed' ? 'bed-main' : `chair-${chairIndex++}`
  return Object.freeze({ id, kind: item.kind === 'bed' ? 'lie' : 'sit', name: item.kind === 'bed' ? '卧室床' : '椅子',
    position: Object.freeze(position), entry: Object.freeze(exit), exit: Object.freeze(exit), yaw })
})

const VILLA_LAYOUT = Object.freeze({
  floors: Object.freeze(floors),
  ramps: Object.freeze([studySteps]),
  furniture: Object.freeze(furniture),
  obstacles: Object.freeze(obstacles),
  restSpots: Object.freeze(restSpots),
  entrance: Object.freeze({ x: 1.28, z: 5.24, y: .385, yaw: Math.PI }),
  insideEntrance: Object.freeze({ x: 1.28, z: 2.42, y: GROUND_Y, yaw: Math.PI })
})

export { BAYS, ELEVATOR, GROUND_Y, UPPER_Y, WEST_UPPER_Y, WEST_STUDY_FLOOR, VILLA_LAYOUT }
