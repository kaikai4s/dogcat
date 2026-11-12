const fs = require('fs')
const path = require('path')
const M = require('../../miniprogram/packageMemorial/scene/world-template')
const G = require('../../miniprogram/packageMemorial/scene/geometry')
const base = require('./memorial-world-base-v2.json')
const root = path.resolve(__dirname, '../../miniprogram/packageMemorial/assets', M.CHUNK_DIRECTORY, '..')
fs.mkdirSync(path.join(root, 'chunks'), { recursive: true })
const objects = base.objects.map(p => ({ ...p }))
objects.push(...M.landmarks.filter(p => !objects.some(old => old.id === p.id)))
function add(kind, x, y) {
  if (x < base.width && y < base.height) return
  if (objects.some(p => p.kind === kind && p.x === x && p.y === y)) return
  objects.push({ id: kind + ':' + x + ':' + y, kind, x, y })
}
for (let x = 150; x < M.WIDTH - 100; x += 180) { add('tree', x, 140); add('tree', x, M.HEIGHT - 116) }
for (let y = 320; y < M.HEIGHT - 220; y += 180) { add('tree', 130, y); add('tree', M.WIDTH - 130, y) }
for (let x = 330; x < M.WIDTH - 200; x += 256) for (let y = 350; y < M.HEIGHT - 220; y += 256) {
  if (M.onRoad(x, y, 110) || objects.some(p => Math.hypot(x - p.x, y - p.y) < 185)) continue
  add('tree', x, y)
}
for (const x of M.roadX) for (let y = 260; y < M.HEIGHT - 180; y += 192) for (const side of [-1, 1]) {
  const px = x + side * 94
  if (!M.onRoad(px, y, 12) && objects.every(p => Math.hypot(px - p.x, y - p.y) > 105)) add('shrub', px, y)
}
const obstacles = objects.map(p => {
  const radius = M.PROPS[p.kind].clearance
  return Array.from({ length: 16 }, (_, n) => ({ x: p.x + radius * Math.cos(n * Math.PI / 8), y: p.y + radius * Math.sin(n * Math.PI / 8) }))
})
const cells = G.createCells({ ...M, obstacles }).filter(c => c.corners.every(p => !M.onRoad(p.x, p.y, 12)))
const total = []
for (let cy = 0; cy < M.HEIGHT / M.CHUNK; cy++) for (let cx = 0; cx < M.WIDTH / M.CHUNK; cx++) {
  const id = cx + '-' + cy, x = cx * M.CHUNK, y = cy * M.CHUNK
  const owns = p => p.x >= x && p.x < x + M.CHUNK && p.y >= y && p.y < y + M.CHUNK
  const chunk = { version: M.version, id, cx, cy, objects: objects.filter(owns), cells: cells.filter(c => owns(c.corners[0])) }
  fs.writeFileSync(path.join(root, 'chunks', id + '.json'), JSON.stringify(chunk))
  total.push({ id, objects: chunk.objects.length, cells: chunk.cells.length })
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: M.version, width: M.WIDTH,
  height: M.HEIGHT, chunkSize: M.CHUNK, chunks: total, objectCount: objects.length, cellCount: cells.length }, null, 2))
console.log(`Built ${total.length} chunks, ${objects.length} objects, ${cells.length} uniform plots`)
// Compact, versioned metadata for the full map, routing and server-side plot validation.
const index = { version: M.version, objects, cells: cells.map(c => ({ id: c.id, lawn: M.lawns.find(l => G.inside(c.corners[0], l.polygon)).name, x: c.corners[0].x + 20, y: c.corners[0].y + 16 })) }
fs.writeFileSync(path.resolve(__dirname, '../../miniprogram/packageMemorial/scene/world-index.js'), 'module.exports = ' + JSON.stringify(index) + '\n')
fs.writeFileSync(path.resolve(__dirname, '../../cloudfunctions/api/config/memorial-world.json'), JSON.stringify(index))

// Rebuild enlarged application footprints whenever scene obstacles change.
require('./build-memorial-plots')

// Presence validation uses the same scene boundary as movement.
fs.writeFileSync(path.resolve(__dirname, '../../cloudfunctions/api/config/memorial-presence.json'), JSON.stringify({ version: M.version, minX: Math.min(...M.boundary.map(p => p.x)), maxX: Math.max(...M.boundary.map(p => p.x)), minY: Math.min(...M.boundary.map(p => p.y)), maxY: Math.max(...M.boundary.map(p => p.y)) }, null, 2) + '\n')
