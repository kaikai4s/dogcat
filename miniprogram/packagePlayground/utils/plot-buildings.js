const typeOf = (b) => b && (b.type || b.buildingType) || ''
const categoryOf = (b) => b && (b.category || b.buildingCategory) || ''
const isPublicBuilding = (b) => categoryOf(b) === 'public' || ['committee', 'police_station', 'prison', 'pet_hospital', 'repair_shop'].includes(typeOf(b))
const isFloorBuilding = (b) => categoryOf(b) === 'floor' || /^floor(?:_|$)/.test(typeOf(b))
const isTreeBuilding = (b) => categoryOf(b) === 'tree' || /^(?:tree|landscape)(?:_|$)/.test(typeOf(b))
function placedBuildings(plot = {}) {
  if (Array.isArray(plot.buildings)) return plot.buildings.map((b) => ({ ...b }))
  let type = plot.buildingType || ''
  const legacyCabin = plot.buildingId === 'residential_wood_cabin' && Number(plot.buildingWidth) > 0
  if (legacyCabin && type === 'residential') type = 'wood_cabin'
  if (!type || type === 'yard' || (type === 'residential' && (!plot.isNewPlot || !plot.buildingId))) return []
  const x = Number(plot.x) || 0, z = Number(plot.z) || 0
  return [{
    instanceId: 'legacy_' + String(plot.plotId || plot.id || plot._id || [plot.ownerOpenid || '', x, z].join('_')),
    buildingId: plot.buildingId || '', type, category: plot.buildingCategory || '',
    name: plot.buildingName || '建筑', image: plot.buildingImage || '',
    width: Number(plot.buildingWidth) || 7, depth: Number(plot.buildingDepth) || 7,
    x: plot.buildingX != null ? Number(plot.buildingX) : x + (Number(plot.buildingOffsetX) || 0),
    z: plot.buildingZ != null ? Number(plot.buildingZ) : z + (Number(plot.buildingOffsetZ) || 0)
  }]
}
function withBuildings(plot, buildings) {
  const list = buildings.map((b) => ({ ...b }))
  const primary = plot.isNewPlot ? list.find(isPublicBuilding) || list[0] : null
  const x = primary ? primary.x : Number(plot.x), z = primary ? primary.z : Number(plot.z)
  const owner = plot.ownerName || '我'
  return { ...plot, buildings: list,
    buildingId: primary ? primary.buildingId || '' : '',
    buildingType: primary ? typeOf(primary) : plot.isNewPlot ? 'yard' : 'residential',
    buildingCategory: primary ? categoryOf(primary) : '',
    buildingName: primary ? primary.name || '建筑' : '',
    buildingImage: primary ? primary.image || '' : '',
    buildingWidth: primary ? Number(primary.width) || 7 : 0,
    buildingDepth: primary ? Number(primary.depth) || 7 : 0,
    buildingX: x, buildingZ: z, buildingOffsetX: x - Number(plot.x), buildingOffsetZ: z - Number(plot.z),
    name: primary ? `${owner}的${primary.name || '建筑'}` : `${owner}的${plot.isNewPlot ? '专属爱心绿地' : '庭院'}`
  }
}
function validateBuildingPlacement(plot, building, point, excludeInstanceId) {
  const width = Number(building.width) || 7, depth = Number(building.depth) || 7
  const x = Number(point.x), z = Number(point.z), half = (Number(plot.size) || 48) / 2
  if (![x, z, width, depth].every(Number.isFinite) || width <= 0 || depth <= 0) return '无效的建筑坐标或尺寸'
  if (x - width / 2 < plot.x - half + 1 || x + width / 2 > plot.x + half - 1 || z - depth / 2 < plot.z - half + 1 || z + depth / 2 > plot.z + half - 1)
    return '草坪方块空间不足，建筑部分超出地皮围栏范围'
  const others = placedBuildings(plot).filter((b) => !excludeInstanceId || b.instanceId !== excludeInstanceId)
  if (isPublicBuilding(building)) {
    if (!plot.isNewPlot) return '公共配套大设施只能在独立的专属绿地上设立，不可占用最初的自家庭院'
    if (others.some(isPublicBuilding)) return '公共配套大设施一个地皮只能建立一个！如需更换请先拆除'
  }
  if (isFloorBuilding(building)) return null
  if (!plot.isNewPlot && Math.abs(x - plot.x) < width / 2 + 9 && Math.abs(z - plot.z) < depth / 2 + 9)
    return '建筑位置与自家庭院原有别墅重叠，请移至空旷草坪方块'
  if (others.some((b) => !isFloorBuilding(b) && Math.abs(x - b.x) < (width + b.width) / 2 && Math.abs(z - b.z) < (depth + b.depth) / 2))
    return '建筑位置与已有建筑重叠，请移至空旷草坪方块'
  return null
}
function buildingGeometryKey(plot) {
  return JSON.stringify([plot.x, plot.z, plot.size, !!plot.isNewPlot,
    placedBuildings(plot).map((b) => [b.instanceId, b.buildingId, typeOf(b), categoryOf(b), b.width, b.depth, b.x, b.z])])
}
module.exports = { placedBuildings, withBuildings, isPublicBuilding, isFloorBuilding, isTreeBuilding, validateBuildingPlacement, buildingGeometryKey }
