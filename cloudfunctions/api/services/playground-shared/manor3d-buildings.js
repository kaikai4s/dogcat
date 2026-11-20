const world = require('../playground-world')
const { transaction } = require('../playground-transaction')

const COLLECTION = 'pet_playground_plots'
const KIND = 'manor3dBuilding'
const RESERVED_PLOT_ID = 'M151'
const EDGE_INSET = 1
const ROTATIONS = new Set([0, 90, 180, 270])
const BUILDINGS = new Map([
  ['red_tile_villa', { width: 18.63, depth: 10.851 }],
  ['songying_courtyard', { width: 26, depth: 36 }]
])
// Plot rectangles from the shipped manor-v1 terrain, layout version 3.
// Keep this manifest in step with layout.json when publishing a new terrain.
const PLOTS = new Map(require('./manor3d-building-plots.json').map(([id, x, z, width, depth]) => [id, { x, z, width, depth }]))

const soloSceneId = openid => 'solo_' + world.hash(openid)
const canBuild = (openid, actor, sceneId) => actor?.manor3dSession === true && (
  sceneId === soloSceneId(openid) ||
  (!!sceneId && actor.communityId === sceneId && actor.manor3dCommunityRetired !== true))

function checkFootprint({ buildingId, plotId, x, z, rotation }) {
  const building = BUILDINGS.get(buildingId), plot = PLOTS.get(plotId)
  if (!building) throw new Error('请选择可建造的建筑')
  if (!ROTATIONS.has(rotation)) throw new Error('请选择 0°、90°、180° 或 270° 朝向')
  if (!plot || plotId === RESERVED_PLOT_ID) throw new Error('这块地不能建造')
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('建造位置无效')
  const turned = rotation === 90 || rotation === 270
  const width = turned ? building.depth : building.width
  const depth = turned ? building.width : building.depth
  const limitsX = (plot.width - width) / 2 - EDGE_INSET
  const limitsZ = (plot.depth - depth) / 2 - EDGE_INSET
  if (limitsX < 0 || limitsZ < 0 || Math.abs(x - plot.x) > limitsX + 1e-7 || Math.abs(z - plot.z) > limitsZ + 1e-7) {
    throw new Error('这个朝向下建筑占地超出可建造范围')
  }
  return { buildingId, plotId, x, z, rotation }
}

function publicBuilding(row) {
  const { _id, ownerOpenid, buildingId, plotId, x, z, rotation } = row
  return { kind: KIND, id: _id, ownerId: 'presence_' + world.hash(ownerOpenid), buildingId, plotId, x, z, rotation }
}

function create(context, { check, publish, project }) {
  const { db } = context
  return async function place(openid, user, data) {
    if (typeof data?.session !== 'string' || !data.session || typeof data.sceneId !== 'string' || !data.sceneId) {
      throw new Error('场景已切换，请重新进入')
    }
    const placement = checkFootprint(data)
    const row = await transaction(db, async tx => {
      const actor = await check(openid, data, tx)
      const communityId = actor.communityId
      if (!canBuild(openid, actor, communityId)) throw new Error('只能在当前已进入的 3D 小区建造')
      // Deterministic document ID serializes claims to a tile in the same scene.
      const id = 'manor3d_building_' + world.hash(communityId + '|' + placement.plotId)
      const existing = await world.readDocument(tx, COLLECTION, id, '读取 3D 地块占用', true)
      if (existing) {
        const same = existing.ownerOpenid === openid && Object.keys(placement).every(key => existing[key] === placement[key])
        if (same) return existing
        throw new Error('这块地已经有建筑，请选择另一块')
      }
      const saved = {
        kind: KIND, communityId, ownerOpenid: openid, ...placement,
        community: actor.manor3dCommunity || null,
        revision: context.nowMs ? context.nowMs() : Date.now()
      }
      await tx.collection(COLLECTION).doc(id).set({ data: saved })
      return { ...saved, _id: id }
    })
    // Retrying the same placement also repairs a failed live projection.
    await publish(row)
    return { record: { ...project(row), mine: true } }
  }
}

module.exports = { KIND, canBuild, create, publicBuilding }
