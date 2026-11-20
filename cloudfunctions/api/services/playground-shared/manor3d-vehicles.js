const world = require('../playground-world')
const { transaction } = require('../playground-transaction')

const COLLECTION = 'pet_playground_plots'
const KIND = 'manor3dVehicle'
const WIDTH = 1200
const DEPTH = 960
const RED_VILLA = 'red_tile_villa'
const vehicleId = (openid, communityId) => 'manor3d_vehicle_' + world.hash(openid + '|' + communityId)

function besideVilla(villa) {
  const yaw = -villa.rotation * Math.PI / 180
  const localX = 18.63 / 2 + 3.4
  return {
    position3d: {
      x: villa.x + localX * Math.cos(yaw),
      y: 0,
      z: villa.z - localX * Math.sin(yaw)
    },
    yaw
  }
}

function create(context, hooks) {
  const { db } = context
  const now = () => context.nowMs ? context.nowMs() : Date.now()
  const read = (database, id) => world.readDocument(database, COLLECTION, id, '读取 3D 车辆', true)
  const save = async (tx, id, row) => {
    const { _id, ...data } = row
    await tx.collection(COLLECTION).doc(id).set({ data })
    return { ...data, _id: id }
  }

  async function ensureForVilla(openid, villa) {
    if (!villa || villa.kind !== 'manor3dBuilding' || villa.buildingId !== RED_VILLA) return null
    const id = vehicleId(openid, villa.communityId)
    const result = await transaction(db, async tx => {
      const existing = await read(tx, id)
      if (existing) {
        if (existing.ownerOpenid !== openid || existing.communityId !== villa.communityId) throw new Error('车辆归属记录无效')
        return existing
      }
      const initial = besideVilla(villa)
      return save(tx, id, {
        kind: KIND,
        ownerOpenid: openid,
        communityId: villa.communityId,
        buildingId: villa._id,
        position3d: initial.position3d,
        yaw: initial.yaw,
        moving: false,
        online: false,
        lastSeen: now(),
        revision: now(),
        seq: 0
      })
    })
    await hooks.publish(result)
    return result
  }

  async function sync(openid, data) {
    if (!Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error('车辆同步序号无效')
    if (data.online !== undefined && typeof data.online !== 'boolean') throw new Error('车辆在线状态无效')
    const result = await transaction(db, async tx => {
      const actor = await hooks.check(openid, data, tx)
      if (actor.manor3dSession !== true) throw new Error('请先进入 3D 庄园再同步车辆')
      const id = vehicleId(openid, actor.communityId)
      const row = await read(tx, id)
      if (!row || row.kind !== KIND || row.ownerOpenid !== openid) throw new Error('当前小区没有属于你的 Copper GT')
      if (data.seq <= Number(row.seq || 0)) return { row, accepted: false }
      const position = data.position3d
      if (!position || ![position.x, position.y, position.z, data.yaw].every(Number.isFinite) ||
          Math.abs(position.x) > WIDTH / 2 || Math.abs(position.z) > DEPTH / 2 || Math.abs(position.y) > 1200 ||
          Math.abs(data.yaw) > Math.PI * 4) throw new Error('车辆位置或朝向无效')
      if (data.online !== false && typeof data.moving !== 'boolean') throw new Error('车辆移动状态无效')
      row.position3d = { x: position.x, y: position.y, z: position.z }
      row.yaw = data.yaw
      row.moving = data.online !== false && data.moving
      row.online = data.online !== false
      row.lastSeen = now()
      row.seq = data.seq
      row.revision = Math.max(row.lastSeen, (row.revision || 0) + 1)
      return { row: await save(tx, id, row), accepted: true }
    })
    if (result.accepted) await hooks.publish(result.row)
    return { accepted: result.accepted, ackSeq: result.row.seq, vehicle: hooks.publicRecord(result.row), serverTime: now() }
  }

  return { KIND, ensureForVilla, sync, vehicleId }
}

module.exports = create
module.exports.KIND = KIND
module.exports.vehicleId = vehicleId
