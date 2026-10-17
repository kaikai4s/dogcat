const YARD_SIZE = 112
const FOUNTAIN_FRAMES = Array.from({ length: 6 }, (_, i) => `pq/pq${i + 1}`)
const YARD_EXTRAS = [
  ...FOUNTAIN_FRAMES,
  'dog_eat',
  'cat_eat',
  'dog_wo',
  'cat_wo'
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
  const sprites = [
    { name: 'house', x: plot.x, z: plot.z, size: 38, radius: 9, anchor: 0.78 },
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
    item('street_lamp', 0.18, 0.77, 10, 0.7)
  ]
  const stations = Object.fromEntries(
    ['dog', 'cat'].map((species) => {
      const bowl = sprites.find((p) => p.name === `${species}_eat`)
      const bed = sprites.find((p) => p.name === `${species}_wo`)
      return [
        species,
        {
          eat: { x: bowl.x, z: bowl.z + bowl.radius + 1.8 },
          sleep: { x: bed.x, z: bed.z + bed.radius + 1.8 }
        }
      ]
    })
  )
  return { half, sprites, stations }
}

module.exports = { YARD_SIZE, FOUNTAIN_FRAMES, YARD_EXTRAS, yardLayout }
