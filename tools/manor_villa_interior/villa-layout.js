const floors = [
  { minX: -6.46, maxX: 6.46, minZ: -3.60, maxZ: 3.56, y: .405, level: 1 },
  { minX: 6.46, maxX: 7.53, minZ: -4.34, maxZ: 4.93, y: .405, level: 1 },
  { minX: -10.32, maxX: -6.46, minZ: -3.43, maxZ: 3.22, y: .405, level: 1 },

  { minX: -6.46, maxX: -5.40, minZ: -3.60, maxZ: 3.56, y: 3.43, level: 2 },
  { minX: -4.00, maxX: 6.46, minZ: -3.60, maxZ: 3.56, y: 3.43, level: 2 },
  { minX: -5.40, maxX: -4.00, minZ: -3.60, maxZ: -2.80, y: 3.43, level: 2 },
  { minX: -5.40, maxX: -4.00, minZ: .42, maxZ: 3.56, y: 3.43, level: 2 },
  { minX: 6.46, maxX: 7.53, minZ: -4.34, maxZ: 4.93, y: 3.43, level: 2 },
  { minX: -10.32, maxX: -6.46, minZ: -3.43, maxZ: 3.22, y: 2.69, level: 2 }
]

const ramps = [
  { minX: -5.40, maxX: -4.00, minZ: -2.80, maxZ: 2.80, fromY: 3.43, toY: .405, axis: 'z', level: 1 },
  { minX: -9.64, maxX: -9.02, minZ: -.70, maxZ: 2.25, fromY: 2.69, toY: .405, axis: 'z', level: 1 }
]

const furniture = [
  { minX: -3.65, maxX: -.65, minZ: 1.14, maxZ: 2.62, level: 1, kind: 'sofa' },
  { minX: -3.26, maxX: -1.18, minZ: -.34, maxZ: .84, level: 1, kind: 'coffee' },
  { minX: -6.15, maxX: -5.72, minZ: -.43, maxZ: 1.56, level: 1, kind: 'fireplace' },
  { minX: -6.15, maxX: -5.77, minZ: -2.82, maxZ: -.78, level: 1, kind: 'shelf' },
  { minX: 6.72, maxX: 7.36, minZ: -3.86, maxZ: -.56, level: 1, kind: 'kitchen' },
  { minX: 3.33, maxX: 5.83, minZ: .43, maxZ: 1.81, level: 1, kind: 'dining' },
  { minX: -9.74, maxX: -8.09, minZ: 1.52, maxZ: 2.76, level: 1, kind: 'pet' },
  { minX: -8.19, maxX: -6.91, minZ: -.90, maxZ: .30, level: 1, kind: 'shelf' },

  { minX: 4.19, maxX: 6.28, minZ: -3.13, maxZ: -1.05, level: 2, kind: 'bed' },
  { minX: -4.52, maxX: -4.08, minZ: -.55, maxZ: .32, level: 2, kind: 'shelf' },
  { minX: -.30, maxX: 2.24, minZ: 1.23, maxZ: 2.58, level: 2, kind: 'sofa' },
  { minX: .02, maxX: 1.77, minZ: -.46, maxZ: .63, level: 2, kind: 'coffee' },
  { minX: -6.16, maxX: -5.73, minZ: -2.82, maxZ: .93, level: 2, kind: 'shelf' },
  { minX: -9.74, maxX: -8.12, minZ: 1.53, maxZ: 2.77, level: 2, kind: 'bed' }
]

const obstacles = furniture.map(({ minX, maxX, minZ, maxZ, level }) =>
  ({ minX, maxX, minZ, maxZ, level }))

const VILLA_LAYOUT = Object.freeze({
  floors: Object.freeze(floors),
  ramps: Object.freeze(ramps),
  furniture: Object.freeze(furniture),
  obstacles: Object.freeze(obstacles),
  entrance: Object.freeze({ x: 1.28, z: 5.24, y: .385, yaw: Math.PI }),
  insideEntrance: Object.freeze({ x: 1.28, z: 2.42, y: .405, yaw: Math.PI })
})

export { VILLA_LAYOUT }
