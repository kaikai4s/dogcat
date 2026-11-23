const RIVER_SEGMENTS = 48

function percent(value, span) {
  return Math.round(Math.max(0, Math.min(100, (value / span + 0.5) * 100)) * 10) / 10
}

function projectManorMapPoint(minimap, x, z) {
  if (!minimap || ![x, z].every(Number.isFinite)) return null
  return { x: percent(x, minimap.worldWidth), y: percent(z, minimap.worldDepth) }
}

function projectManorMapTowers(minimap, footprints) {
  return footprints.map(({ id, x, z, width, depth }) => ({
    id, ...projectManorMapPoint(minimap, x, z),
    width: width / minimap.worldWidth * 100, height: depth / minimap.worldDepth * 100
  }))
}

function riverOutline(landscape, minimap) {
  let stream
  landscape?.traverse?.(node => {
    if (node.isMesh && /Winding[ _]+clear[ _]+stream/i.test(node.name)) stream = node
  })
  const positions = stream?.geometry?.getAttribute('position')
  const matrix = stream?.matrixWorld?.elements
  if (!positions || !matrix || positions.count < 4 || matrix[0] <= 0 ||
      Math.abs(matrix[4]) + Math.abs(matrix[8]) > 1e-5) return ''

  // The exported stream is a row-major grid. Its first and last rows form the banks.
  let columns = 1
  while (columns < positions.count && positions.getX(columns) > positions.getX(columns - 1)) columns++
  const southRow = positions.count - columns
  if (columns < 2 || southRow < columns || positions.count % columns !== 0 ||
      Math.abs(positions.getX(southRow) - positions.getX(0)) > 1e-5) return ''

  const worldX = index => matrix[0] * positions.getX(index) + matrix[12]
  const worldZ = index => matrix[2] * positions.getX(index) + matrix[6] * positions.getY(index) +
    matrix[10] * positions.getZ(index) + matrix[14]
  const start = Math.max(-minimap.worldWidth / 2, worldX(0))
  const end = Math.min(minimap.worldWidth / 2, worldX(columns - 1))
  if (!(start < end)) return ''

  const banks = [[], []]
  let column = 0
  for (let point = 0; point <= RIVER_SEGMENTS; point++) {
    const x = start + (end - start) * point / RIVER_SEGMENTS
    while (column + 1 < columns - 1 && worldX(column + 1) < x) column++
    const ratio = (x - worldX(column)) / (worldX(column + 1) - worldX(column))
    for (const [bank, row] of [[0, 0], [1, southRow]]) {
      const z = worldZ(column + row) * (1 - ratio) + worldZ(column + row + 1) * ratio
      const projected = projectManorMapPoint(minimap, x, z)
      if (!projected) return ''
      banks[bank].push(`${projected.x}% ${projected.y}%`)
    }
  }
  return `polygon(${banks[0].concat(banks[1].reverse()).join(',')})`
}

function createManorMinimap(layout, landscape) {
  const { width: worldWidth, depth: worldDepth } = layout?.world || {}
  if (![worldWidth, worldDepth].every(size => Number.isFinite(size) && size > 0)) return null
  const minimap = { worldWidth, worldDepth }
  const shapes = (items, getSize) => (Array.isArray(items) ? items : []).flatMap((item, index) => {
    if (!item || Math.abs(item.x) > worldWidth / 2 || Math.abs(item.z) > worldDepth / 2) return []
    const point = projectManorMapPoint(minimap, item.x, item.z)
    const [width, depth] = getSize(item)
    if (!point || ![width, depth].every(size => Number.isFinite(size) && size > 0)) return []
    const angle = Number.isFinite(item.yaw) ? Math.round(-item.yaw * 180 / Math.PI) : 0
    return [{ id: item.id || index, ...point, width: width / worldWidth * 100, height: depth / worldDepth * 100, angle }]
  })
  const { bridge, crossings } = layout
  const bridges = Array.isArray(crossings) && crossings.length ? crossings : bridge ? [{ ...bridge, length: bridge.width }] : []
  return {
    ...minimap,
    river: riverOutline(landscape, minimap),
    plots: shapes(layout.plots, item => [item.width, item.depth]),
    crossings: shapes(bridges, item => [item.width, item.length]),
    trees: shapes(layout.landmarkTrees, item => [item.r * 2, item.r * 2]),
    towers: []
  }
}

module.exports = { createManorMinimap, projectManorMapPoint, projectManorMapTowers }
