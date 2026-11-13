// Keep canonical IDs and existing memorials; only new applications use the larger footprint.
const fs = require('fs'), path = require('path')
const M = require('../../miniprogram/packageMemorial/scene/world-template')
const G = require('../../miniprogram/packageMemorial/scene/geometry')
const world = require('../../miniprogram/packageMemorial/scene/world-index')
const obstacles = world.objects.map(p => Array.from({ length: 16 }, (_, i) => ({
  x: p.x + M.PROPS[p.kind].clearance * Math.cos(i * Math.PI / 8),
  y: p.y + M.PROPS[p.kind].clearance * Math.sin(i * Math.PI / 8)
})))
const ids = world.cells.filter(p => G.validCell(M.rect(p.x - 56, p.y - 48, 112, 96), { ...M, obstacles })).map(p => p.id)
const data = { version: world.version, spacing: 128, width: 112, depth: 96, ids }
const root = path.resolve(__dirname, '../..')
fs.writeFileSync(path.join(root, 'miniprogram/packageMemorial/scene/plot-layout.js'), 'module.exports = ' + JSON.stringify(data) + '\n')
fs.writeFileSync(path.join(root, 'cloudfunctions/api/config/memorial-plots.json'), JSON.stringify(data) + '\n')
console.log('Larger clear footprints:', ids.length)
