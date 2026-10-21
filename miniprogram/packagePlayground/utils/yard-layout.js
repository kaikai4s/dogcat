const { placedBuildings, isFloorBuilding, isTreeBuilding } = require('./plot-buildings')
const YARD_SIZE = 112
// The minimum gap between yards is four metres; cars must fit those lanes.
const VEHICLE_RADIUS = 1.4
const FOUNTAIN_FRAMES = Array.from({ length: 6 }, (_, i) => `pq/pq${i + 1}`)
const YARD_EXTRAS = [
  ...FOUNTAIN_FRAMES,
  'dog_eat',
  'cat_eat',
  'dog_wo',
  'cat_wo',
  'car_road',
  'car_house'
]

function yardLayout(plot) {
  const half = (plot.size || YARD_SIZE) / 2
  const detailScale = Math.min(1, half / 48)
  const item = (name, x, z, size, radius = 0, anchor = 0.86) => ({
    name,
    x: plot.x + x * half,
    z: plot.z + z * half,
    size: size * detailScale,
    radius: radius * detailScale,
    anchor
  })
  let houseItemX = 0
  let houseItemZ = 0
  if (plot.buildingX !== undefined && plot.buildingX !== null) {
    houseItemX = (Number(plot.buildingX) - plot.x) / half
  } else if (plot.buildingOffsetX !== undefined && plot.buildingOffsetX !== null) {
    houseItemX = Number(plot.buildingOffsetX) / half
  }
  if (plot.buildingZ !== undefined && plot.buildingZ !== null) {
    houseItemZ = (Number(plot.buildingZ) - plot.z) / half
  } else if (plot.buildingOffsetZ !== undefined && plot.buildingOffsetZ !== null) {
    houseItemZ = Number(plot.buildingOffsetZ) / half
  }
  const sprites = [
    item('house', houseItemX, houseItemZ, 38, 9, 0.78),
    item('tree', -0.72, -0.64, 18, 2.6, 0.74),
    item('tree', 0.72, -0.64, 18, 2.6, 0.74),
    item('tree', 0.75, 0.05, 15, 2.1, 0.74),
    item('flower_bush', -0.76, 0.13, 9, 1.5),
    item('flower_bush', -0.76, 0.73, 9, 1.5),
    item('flower_bush', 0.73, 0.73, 9, 1.5),
    item('fountain', 0.5, 0.43, 20, 4.2, 0.7),
    item('dog_wo', -0.55, 0.38, 11, 2.8, 0.64),
    item('cat_wo', -0.55, 0.7, 10, 2.5, 0.64),
    item('dog_eat', -0.27, 0.38, 6, 1.1, 0.64),
    item('cat_eat', -0.27, 0.7, 6, 1.1, 0.64),
    item('street_lamp', 0.18, 0.77, 10, 0.7),
    item('car_house', -0.68, -0.40, 28, 6.2, 0.67),
    item('car_road', -0.68, -0.15, 15, 0, 0.54)
  ]
  const stations = Object.fromEntries(
    ['dog', 'cat'].map((species) => {
      const bowl = sprites.find((p) => p.name === `${species}_eat`)
      const bed = sprites.find((p) => p.name === `${species}_wo`)
      return [
        species,
        {
          eat: { x: bowl.x, z: bowl.z + bowl.radius + 1.8 },
          sleep: { x: bed.x, z: bed.z + bed.radius + 1.8 },
          drink: { x: plot.x + .5 * half, z: plot.z + .43 * half + 4.2 * detailScale + 1.8 }
        }
      ]
    })
  )
  const spot=sprites.find((p)=>p.name==='car_road')
  // Explicit instance arrays identify migrated homes; legacy non-residential
  // records without isNewPlot must still render as standalone buildings.
  const residential = !plot.isNewPlot && (Array.isArray(plot.buildings) || !plot.buildingType || plot.buildingType === 'residential')
  if (residential && Array.isArray(plot.buildings)) sprites[0] = item('house', 0, 0, 38, 9, 0.78)
  const visibleSprites = residential ? sprites : []
  for (const building of placedBuildings(plot)) {
    const bW = Number(building.width) || 7, bD = Number(building.depth) || 7
    const floor = isFloorBuilding(building), tree = isTreeBuilding(building)
    visibleSprites.push({
      name: 'house', building, buildingInstanceId: building.instanceId,
      x: building.x, z: building.z, size: Math.max(bW, bD) * 2,
      radius: floor ? 0 : tree ? Math.min(1.5, Math.max(0.6, bW * 0.15)) : Math.max(bW, bD) / 2,
      anchor: floor ? 0.5 : tree ? 0.88 : 0.8
    })
  }
  if (!residential && !visibleSprites.length && plot.buildingType && plot.buildingType !== 'yard' && !Array.isArray(plot.buildings)) visibleSprites.push(sprites[0])
  return { half, sprites:visibleSprites, stations, parking:{x:spot.x,z:spot.z}, vehicleSize:13*detailScale }
}

module.exports = { YARD_SIZE, VEHICLE_RADIUS, FOUNTAIN_FRAMES, YARD_EXTRAS, yardLayout }
