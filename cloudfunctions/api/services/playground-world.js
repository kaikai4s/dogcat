const { transaction } = require('./playground-transaction')
const crypto = require('crypto')
const nameColors = require('./playground-name-colors')
const {memberAccess,unlocked}=require('./playground-access')
const { placedBuildings, withBuildings, isPublicBuilding, validateBuildingPlacement } = require('./playground-shared/plot-buildings')
const SIZE = 112
const STEP = 56
const GAP = 4
// Temporary relocation switch. Set PLAYGROUND_ALLOW_RELOCATION=false to lock it.
const allowRelocation = () =>
  process.env.PLAYGROUND_ALLOW_RELOCATION !== 'false'
const CHUNK = STEP * 2
const CONFIG_ID = 'world_config_v2'
const hash = (value) =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
async function readDocument(db, collection, id, label, optional = false) {
  try {
    return (await db.collection(collection).doc(id).get()).data || null
  } catch (error) {
    const message = [
      ...new Set(
        [
          error && error.message,
          error && error.errMsg,
          typeof error === 'string' ? error : ''
        ].filter(Boolean)
      )
    ].join(' | ')
    if (
      optional &&
      (message.includes(`document with _id ${id} does not exist`) ||
        /\bdocument (?:does not exist|not found)\b|文档不存在/i.test(message))
    )
      return null
    throw Object.assign(
      new Error(`${label}失败：${message || '未知数据库错误'}`),
      {
        code: error && (error.code || error.errCode)
      }
    )
  }
}
async function read(db, id) {
  const label =
    id === CONFIG_ID
      ? '读取场景设置'
      : id.startsWith('plot_owner_')
        ? '读取已保存庭院'
        : '检查草坪占地'
  return readDocument(db, 'pet_playground_plots', id, label, true)
}
function dimensions(value = {}) {
  const result = {}
  for (const key of ['width', 'height']) {
    const n = value[key] === undefined ? 2240 : Number(value[key])
    if (!Number.isInteger(n) || n < 224 || n > 11200)
      throw new Error('乐园宽高须为 224～11200 之间的整数')
    result[key] = n
  }
  return result
}
function communityId(user) {
  const c = user.residentialCommunity
  if (!c || !String(c.name || '').trim()) return ''
  return hash(
    [c.city, c.district, c.name, c.address]
      .map((v) =>
        String(v || '')
          .trim()
          .replace(/\s+/g, '')
      )
      .join('|')
  )
}
const ownerId = (openid) => `plot_owner_${hash(openid)}`
const plotId = (id, x, z) => `plot_${id}_${x}_${z}`
function isResidence(plot) {
  return !!(plot && plot.ownerOpenid && !plot.demolished && !plot.isNewPlot &&
    (!plot.buildingType || plot.buildingType === 'residential'))
}
function publicPlot(plot, openid) {
  if (!plot) return null
  return {
    id: plot._id,
    x: plot.x,
    z: plot.z,
    size: Number(plot.size) || 48,
    cellX: plot.cellX,
    cellZ: plot.cellZ,
    mine: plot.ownerOpenid === openid,
    foodBowls: { dog: Math.max(0,Math.min(100,Number(plot.foodBowls&&plot.foodBowls.dog)||0)), cat: Math.max(0,Math.min(100,Number(plot.foodBowls&&plot.foodBowls.cat)||0)) },
    gardenVersion:plot.gardenVersion||1,
    farmBeds: Array.isArray(plot.farmBeds) ? plot.farmBeds : [],
    ownerName: plot.ownerName || String(plot.name || '邻居').replace(/的庭院$/, ''),
    nameColor: plot.nameColor || '',
    ownerId: 'presence_' + hash(plot.ownerOpenid),
    instanceId: plot.instanceId || plot.createdAt || '',
    gateDirection: plot.gateDirection || 'south',
    name: plot.name || '邻居庭院',
    buildings: placedBuildings(plot),
    buildingId: plot.buildingId || '',
    buildingType: plot.buildingType || (plot.isNewPlot ? 'yard' : 'residential'),
    buildingCategory: plot.buildingCategory || '',
    buildingName: plot.buildingName || '',
    buildingImage: plot.buildingImage || '',
    buildingWidth: Number(plot.buildingWidth) || 0,
    buildingDepth: Number(plot.buildingDepth) || 0,
    buildingX: plot.buildingX !== undefined && plot.buildingX !== null ? Number(plot.buildingX) : undefined,
    buildingZ: plot.buildingZ !== undefined && plot.buildingZ !== null ? Number(plot.buildingZ) : undefined,
    buildingOffsetX: plot.buildingOffsetX !== undefined && plot.buildingOffsetX !== null ? Number(plot.buildingOffsetX) : undefined,
    buildingOffsetZ: plot.buildingOffsetZ !== undefined && plot.buildingOffsetZ !== null ? Number(plot.buildingOffsetZ) : undefined,
    isNewPlot: Boolean(plot.isNewPlot),
    isResidence: isResidence(plot),
    demolished: Boolean(plot.demolished),
    staffCard: plot.staffCard ? { id: plot.staffCard.id, label: plot.staffCard.label } : null
  }
}
async function updateCommunity(db, openid, userId, community, extra = {}) {
  return transaction(db,async (tx) => {
    const placed = await read(tx, ownerId(openid))
    if (
      placed &&
      communityId({ residentialCommunity: community }) !== placed.communityId
    ) {
      throw new Error('请先拆除原小区庭院，才能迁入新小区；已有庭院时不能更换所属小区')
    }
    await tx
      .collection('users')
      .doc(userId)
      .update({ data: { ...extra, residentialCommunity: community } })
  })
}
module.exports = {
  SIZE,
  STEP,
  CHUNK,
  CONFIG_ID,
  read,
  dimensions,
  communityId,
  ownerId,
  plotId,
  isResidence,
  hash,
  readDocument,
  updateCommunity,
  allowRelocation,
  create({ db, nowText, nowMs }) {
    const stamp=()=>nowMs?nowMs():Date.now()
    async function config() {
      const stored = (await read(db, CONFIG_ID)) || {}
      return {
        ...dimensions(),
        ...stored,
        plotSize: SIZE,
        plotSizes: (await require('./playground-buildings')({db}).readCatalog()).plotSizes,
        step: STEP,
        chunkSize: CHUNK,
        canRelocate: allowRelocation()
      }
    }
    async function resolveOwnerPlot(database, openid) {
      let plot = await read(database, ownerId(openid))
      let myPlots = []
      try {
        const res = await database.collection('pet_playground_plots').where({ kind: 'plot', ownerOpenid: openid }).get()
        myPlots = (res && res.data) || []
      } catch (e) {
        myPlots = []
      }

      // Only restore a real home. Legacy public facilities on independent plots
      // must never be mistaken for the owner's original residence.
      const homeCandidate = (p) => !p.isNewPlot && !isPublicBuilding(p)
      let residential = myPlots.find(p => !p.demolished && homeCandidate(p))
      if (!residential) {
        const softDemolished = myPlots.find(p => p.demolished && homeCandidate(p))
        if (softDemolished) residential = softDemolished
      }
      if (residential) {
        const restored = withBuildings({ ...residential, isNewPlot: false, demolished: false }, placedBuildings(residential))
        if (JSON.stringify(restored) !== JSON.stringify(residential) || residential.demolished) {
          restored.updatedAt = nowText()
          restored.revision = Math.max(stamp(), (residential.revision || 0) + 1)
          const { _id, ...clean } = restored
          await database.collection('pet_playground_plots').doc(_id).set({ data: clean })
        }
        residential = restored
        const { _id, ...cleanResidential } = residential
        if (!plot || plot.demolished || plot.plotId !== _id ||
            plot.buildingType !== 'residential' ||
            JSON.stringify(plot.buildings) !== JSON.stringify(residential.buildings) ||
            plot.revision !== residential.revision) {
          const ownerDoc = { ...cleanResidential, kind: 'owner_plot', plotId: _id }
          await database.collection('pet_playground_plots').doc(ownerId(openid)).set({ data: ownerDoc })
          plot = ownerDoc
        }
      }
      return plot
    }
    async function own(openid) {
      const plot = await resolveOwnerPlot(db, openid)
      return plot ? ensureNameColor(plot) : null
    }
    async function ensureNameColor(plot) {
      if (nameColors.validColor(plot.nameColor)) return plot
      return transaction(db, async (tx) => {
        const owner = await read(tx, ownerId(plot.ownerOpenid))
        const canonical = await read(tx, plot.plotId || plot._id)
        if (!owner || !canonical || owner.plotId !== canonical._id) return plot
        if (nameColors.validColor(owner.nameColor) && owner.nameColor === canonical.nameColor)
          return { ...plot, nameColor: owner.nameColor, revision: canonical.revision }
        const nameColor = await nameColors.allocate(tx, owner.communityId, hash(owner.ownerOpenid), read)
        const revision = Math.max(stamp(), (owner.revision || 0) + 1, (canonical.revision || 0) + 1)
        const patch = { nameColor, revision }
        await tx.collection('pet_playground_plots').doc(owner._id).update({ data: patch })
        await tx.collection('pet_playground_plots').doc(canonical._id).update({ data: patch })
        return { ...plot, ...patch }
      })
    }
    async function ensureNameColors(plots) {
      const result = []
      for (const plot of plots) result.push(await ensureNameColor(plot))
      return result
    }
    async function fillBowl(openid, data) {
      if (typeof data.plotId !== 'string' || !data.plotId.trim())
        throw new Error('请选择自己的狗碗')
      return transaction(db,async (tx) => {
        const plot = await read(tx, ownerId(openid))
        if (!plot || plot.ownerOpenid !== openid || plot.plotId !== data.plotId)
          throw new Error('只能给自己庭院里的狗碗添粮，请重新进入庭院')
        // Filling is idempotent and has no currency or inventory reward.
        if (!plot.foodBowls || plot.foodBowls.dog !== 100 || plot.foodBowls.cat !== 100) {
          const canonical = await read(tx, plot.plotId)
          await tx.collection('pet_playground_plots').doc(ownerId(openid)).update({
            data: { foodBowls: { dog: 100, cat: 100 }, updatedAt: nowText(),revision:Math.max(stamp(),(plot.revision||0)+1) }
          })
          if (canonical) await tx.collection('pet_playground_plots').doc(plot.plotId).update({
            data: { foodBowls: { dog: 100, cat: 100 }, updatedAt: nowText(),revision:Math.max(stamp(),(canonical.revision||0)+1) }
          })
        }
        return { plotId: plot.plotId, food: 100 }
      })
    }
    async function claim(openid, user, data) {
      const px =
        data.x === undefined
          ? Number(data.cellX) * STEP + STEP / 2
          : Number(data.x)
      const pz =
        data.z === undefined
          ? Number(data.cellZ) * STEP + STEP / 2
          : Number(data.z)
      const x = Math.floor(px / STEP),
        z = Math.floor(pz / STEP)
      if (
        ![px, pz].every(Number.isFinite) ||
        x < 0 ||
        z < 0 ||
        (data.cellX !== undefined && Number(data.cellX) !== x) ||
        (data.cellZ !== undefined && Number(data.cellZ) !== z)
      )
        throw new Error('请选择有效的空草坪')
      return transaction(db,async (tx) => {
        const current = await readDocument(
          tx,
          'users',
          user._id,
          '读取当前用户'
        )
        if (!current) throw new Error('用户记录不存在，请重新登录')
        const id = communityId(current)
        if (data.sceneId && data.sceneId !== id) throw new Error('访问其他小区时不能建造庭院，请先迁入该小区')
        if (!id) throw new Error('请先设置常住小区，再选择宅基地')
        const owner = await read(tx, ownerId(openid))
        const canonical = owner && await read(tx, owner.plotId)
        const existing = canonical ? { ...canonical, plotId: canonical._id } : owner
        const nameColor = await nameColors.allocate(tx, id, hash(openid), read)
        const reqSize = Number(data.size)
        const allowedSizes = [36, 48, 64, 80, 112]
        if(data.size!==undefined&&!allowedSizes.includes(reqSize))throw new Error('无效的绿地规格')
        const plotSize = data.size === undefined ? SIZE : reqSize

        const isNewPlot = data.isNewPlot === true

        if (
          !isNewPlot &&
          existing &&
          existing.communityId === id &&
          existing.x === px &&
          existing.z === pz &&
          existing.size === plotSize
        ) {
          if (existing.nameColor !== nameColor) {
            const patch = { nameColor, revision: Math.max(stamp(), (existing.revision || 0) + 1) }
            await tx.collection('pet_playground_plots').doc(existing.plotId).update({ data: patch })
            await tx.collection('pet_playground_plots').doc(ownerId(openid)).update({ data: patch })
            Object.assign(existing, patch)
          }
          return publicPlot({ ...existing, _id: existing.plotId }, openid)
        }
        if (!isNewPlot && existing && !allowRelocation())
          throw new Error('你已经选择过房屋位置，不能更改')
        if (!isNewPlot && existing && existing.communityId !== id)
          throw new Error('只能在原小区调整庭院位置')

        const catalog=await require('./playground-buildings')({db:tx}).readCatalog()
        const access=await memberAccess(tx,openid)
        if(isNewPlot) {
          const option=catalog.plotSizes.find((p)=>p.size===plotSize)
          if(!option||!unlocked(option,access))throw new Error('当前会员等级尚未解锁该绿地规格')
        }
        let building=null
        if(data.buildingId||data.buildingType&&!['yard','residential'].includes(data.buildingType)) {
          building=catalog.buildings.find((b)=>data.buildingId?b.id===data.buildingId:b.type===data.buildingType)
          if(!building||building.enabled===false||!unlocked(building,access))throw new Error('该建筑已下架或当前会员等级尚未解锁')
          if(['committee','police_station','prison'].includes(building.type)) {
            const rows=await tx.collection('pet_playground_plots').where({communityId:id,kind:'plot',buildingType:building.type}).get()
            if((rows.data||[]).some((p)=>!p.demolished))throw new Error('该小区已存在此类公共建筑')
          }
        }

        const { _id: configDocumentId, ...stored } =
          (await read(tx, CONFIG_ID)) || {}
        const settings = { ...dimensions(), ...stored }
        if (
          px - plotSize / 2 < 0 ||
          pz - plotSize / 2 < 0 ||
          px + plotSize / 2 > settings.width ||
          pz + plotSize / 2 > settings.height
        )
          throw new Error('宅基地不能超过场景边界')
        const key = plotId(id, x, z)
        // Keep operations on one transaction ordered; viewport reads outside
        // transactions can still run concurrently.
        const reach = plotSize + GAP
        for (
          let cx = Math.max(0, Math.floor((px - reach) / STEP));
          cx <= Math.floor((px + reach) / STEP);
          cx++
        ) {
          for (
            let cz = Math.max(0, Math.floor((pz - reach) / STEP));
            cz <= Math.floor((pz + reach) / STEP);
            cz++
          ) {
            const other = await read(tx, plotId(id, cx, cz))
            if (!other) continue
            if (!isNewPlot && existing && other._id === existing.plotId && other.ownerOpenid === openid) continue
            const separation = (plotSize + (Number(other.size) || 48)) / 2 + GAP
            if (
              other._id === key ||
              (Math.abs(px - other.x) < separation &&
                Math.abs(pz - other.z) < separation)
            )
              throw new Error('地皮范围与已有建筑或邻居重叠，请选择更空旷的草坪')
          }
        }
        const buildingType = building?building.type:isNewPlot?'yard':existing&&existing.buildingType||'residential'
        const buildingCategory = building?building.category:''
        const buildingId = building?building.id:!isNewPlot&&existing&&existing.buildingId||''
        const buildingName = building?building.name:!isNewPlot&&existing&&existing.buildingName||''
        const buildingImage = building?building.image:!isNewPlot&&existing&&existing.buildingImage||''
        const buildingWidth = building?building.width:!isNewPlot&&existing&&existing.buildingWidth||7
        const buildingDepth = building?building.depth:!isNewPlot&&existing&&existing.buildingDepth||7
        if(Math.max(buildingWidth,buildingDepth)>plotSize-4)throw new Error('这块绿地放不下该建筑')

        let plot = {
          ...(!isNewPlot && existing ? existing : {}),
          kind: 'plot',
          communityId: id,
          ownerOpenid: openid,
          cellX: x,
          cellZ: z,
          x: px,
          z: pz,
          size: plotSize,
          gateDirection: ['south', 'north', 'east', 'west'].includes(data.gateDirection) ? data.gateDirection : (existing && existing.gateDirection) || 'south',
          buildingId,
          buildingType,
          buildingCategory,
          buildingName,
          buildingImage,
          buildingWidth,
          buildingDepth,
          ownerName: String(user.nickname || '我').slice(0, 20),
          nameColor,
          revision: Math.max(await require('./playground-live')({db,nowMs}).nextEpoch(id,key,stamp()),(existing&&existing.revision||0)+1),
          instanceId: !isNewPlot && existing && existing.instanceId || crypto.randomBytes(12).toString('hex'),
          name: buildingName ? `${String(user.nickname || '我').slice(0, 20)}的${buildingName}` : (isNewPlot ? `${String(user.nickname || '我').slice(0, 20)}的专属爱心绿地` : `${String(user.nickname || '我').slice(0, 20)}的庭院`),
          createdAt: existing&&!isNewPlot ? existing.createdAt : nowText(),
          createdAtStamp: !isNewPlot && existing && existing.createdAtStamp || stamp(),
          updatedAt: nowText(),
          ...(building && building.type === 'committee' && (isNewPlot || !existing) ? { committeeStartedAt: stamp(), lastSalaryClaimAt: 0 } : {}),
          isNewPlot: Boolean(isNewPlot)
        }
        // Preserve all courtyard state and move each attachment by the same delta.
        // Legacy claim calls may create a public facility without isNewPlot; those
        // are independent facilities, not residences to be healed into villas.
        const relocating = !isNewPlot && existing
        const independent = isNewPlot || !!(building && isPublicBuilding(building)) || !!(relocating && (existing.isNewPlot || isPublicBuilding(existing)))
        if (relocating && building && isPublicBuilding(building) && !existing.isNewPlot && !isPublicBuilding(existing))
          throw new Error('公共配套大设施不可占用最初的自家庭院')
        let buildings = relocating ? placedBuildings(existing).map((b) => ({
          ...b, x: b.x + px - Number(existing.x), z: b.z + pz - Number(existing.z)
        })) : []
        if (building && !relocating) buildings.push({
          instanceId: data.buildingInstanceId ? String(data.buildingInstanceId) : crypto.randomBytes(12).toString('hex'),
          buildingId: building.id, type: building.type, category: building.category || '',
          name: building.name, image: building.image || '', width: Number(building.width), depth: Number(building.depth),
          x: Number(data.buildingX !== undefined ? data.buildingX : px),
          z: Number(data.buildingZ !== undefined ? data.buildingZ : pz)
        })
        plot = withBuildings({ ...plot, isNewPlot: independent }, buildings)
        for (const instance of buildings) {
          const error = validateBuildingPlacement(plot, instance, instance, instance.instanceId)
          if (error) throw new Error(error)
        }
        if (relocating) preserveRelocatedBeds(existing, plot)
        // Owner mappings and canonical plot identities must not leak into set data.
        delete plot._id
        delete plot.plotId
        // 若为购买新地皮，绝不删除原有的老庭院！原别墅完整保留在原位
        if (!isNewPlot && existing && existing.plotId !== key)
          await tx
            .collection('pet_playground_plots')
            .doc(existing.plotId)
            .remove()
        await tx.collection('pet_playground_plots').doc(key).set({ data: plot })
        // 仅在非新地皮（首次建造主庭院或主动调整主庭院位置）时，更新主庭院映射；新绿地地皮绝不覆盖主庭院
        if (!isNewPlot)
          await tx
            .collection('pet_playground_plots')
            .doc(ownerId(openid))
            .set({ data: { ...plot, kind: 'owner_plot', plotId: key } })
        await tx
          .collection('pet_playground_plots')
          .doc(CONFIG_ID)
          .set({
            data: {
              ...settings,
              usedWidth: Math.max(
                settings.usedWidth || 0,
                Math.ceil(px + SIZE / 2)
              ),
              usedHeight: Math.max(
                settings.usedHeight || 0,
                Math.ceil(pz + SIZE / 2)
              )
            }
          })
        return publicPlot({ ...plot, _id: key }, openid)
      })
    }
    async function region(openid, user, data) {
      const saved = await own(openid)
      const id = data.community ? communityId({ residentialCommunity: data.community }) : saved ? saved.communityId : communityId(user)
      const cfg = await config()
      const x = Number(data.chunkX),
        z = Number(data.chunkZ)
      if (
        ![x, z].every(Number.isInteger) ||
        x < 0 ||
        z < 0 ||
        x * CHUNK >= cfg.width ||
        z * CHUNK >= cfg.height
      )
        throw new Error('场景区域超出边界')
      if (!id) return { plots: [], chunkX: x, chunkZ: z }
      const rows = await Promise.all(
        [0, 1, 2, 3].map((i) =>
          read(db, plotId(id, x * 2 + (i % 2), z * 2 + Math.floor(i / 2)))
        )
      )
      return {
        plots: (await ensureNameColors(rows.filter((p) => p && !p.demolished))).map((p) => publicPlot(p, openid)),
        chunkX: x,
        chunkZ: z
      }
    }
    async function mapOverview(openid, user, data) {
      const saved = await own(openid)
      const id = data.community ? communityId({ residentialCommunity: data.community }) : saved ? saved.communityId : communityId(user)
      if (!id) return { plots: [], nextCursor: '' }
      const where = { communityId: id, kind: 'plot' }
      const cursor = String(data.cursor || '')
      if (cursor.length > 128) throw new Error('无效地图页码')
      if (cursor) where._id = db.command.gt(cursor)
      const rows =
        (
          await db
            .collection('pet_playground_plots')
            .where(where)
            .orderBy('_id', 'asc')
            .limit(100)
            .get()
        ).data || []
      return {
        plots: (await ensureNameColors(rows.filter((p) => !p.plotId && !p.demolished))).map((p) => publicPlot(p, openid)),
        nextCursor: rows.length === 100 ? rows[rows.length - 1]._id : ''
      }
    }
    async function demolish(openid, data, beforeRemove) {
      return transaction(db,async (tx) => {
        const plot = await ownInTransaction(tx, openid)
        if (!plot || plot.ownerOpenid !== openid || data.plotId !== plot.plotId)
          throw new Error('只能拆除自己的当前庭院')
        if (data.sceneId && plot.communityId !== data.sceneId) throw new Error('请回到原小区拆除庭院')
        const released=beforeRemove?await beforeRemove(tx,openid,plot):[]
        await nameColors.release(tx, plot.communityId, hash(openid), read)
        const residentId = 'resident_' + hash(openid)
        const resident = await read(tx, residentId)
        const presenceId = 'presence_' + hash(openid)
        const presence = await read(tx, presenceId)

        // 彻底清理该玩家在当前小区下的所有地皮（主别墅与所有独立专属绿地/商铺/地坪/景观等）
        const allUserPlots = await tx.collection('pet_playground_plots')
          .where({ kind: 'plot', ownerOpenid: openid, communityId: plot.communityId })
          .get()
        const removedPlotIds = []
        for (const p of (allUserPlots.data || [])) {
          await tx.collection('pet_playground_plots').doc(p._id).remove()
          removedPlotIds.push(p._id)
        }
        if (!removedPlotIds.includes(plot.plotId)) {
          await tx.collection('pet_playground_plots').doc(plot.plotId).remove()
          removedPlotIds.push(plot.plotId)
        }

        await tx.collection('pet_playground_plots').doc(ownerId(openid)).remove()
        if (resident) await tx.collection('pet_playground_plots').doc(residentId).remove()
        if (presence) await tx.collection('pet_playground_plots').doc(presenceId).remove()
        const carId='vehicle_'+hash(openid)
        if(await read(tx,carId))await tx.collection('pet_playground_plots').doc(carId).remove()
        const hadPrison = (allUserPlots.data || []).some((p) => p.buildingType === 'prison')
        if (hadPrison) {
          await releasePrisonersIfPrisonRemoved(tx, plot.communityId, stamp())
        }
        return beforeRemove?{ removed: true,released,removedPlotIds }:{ removed: true,removedPlotIds }
      })
    }
    async function releasePrisonersIfPrisonRemoved(tx, communityId, currentStamp) {
      try {
        const prisonRows = await tx.collection('pet_playground_plots').where({ kind: 'plot', communityId, buildingType: 'prison' }).get()
        const stillHasPrison = (prisonRows.data || []).some((p) => !p.demolished)
        if (!stillHasPrison) {
          const jailRows = await tx.collection('pet_playground_jail').where({ communityId, jailed: true }).get()
          for (const item of (jailRows.data || [])) {
            await tx.collection('pet_playground_jail').doc(item._id).update({
              data: {
                jailed: false,
                releasedAt: currentStamp,
                releasedBy: 'facility_dismantled'
              }
            })
            const accRows = await tx.collection('pet_playground_accidents').where({ driverOpenid: item._id, status: 'arrested' }).get()
            for (const acc of (accRows.data || [])) {
              await tx.collection('pet_playground_accidents').doc(acc._id).update({
                data: {
                  status: 'settled',
                  settledAt: currentStamp,
                  settleType: 'facility_dismantled'
                }
              })
            }
          }
        }
      } catch (_) {}
    }
    function selectBuilding(plot, buildings, instanceId) {
      if (!buildings.length) {
        if (!plot.isNewPlot) throw new Error('最初的自家庭院为主住宅；自家庭院原住别墅居于庭院中央，若需搬迁整体庭院请使用安置庭院选址功能')
        throw new Error('该绿地尚未落座建筑，无需调整位置；该绿地当前已是纯草块，无需重复拆除')
      }
      if (!instanceId && buildings.length > 1) throw new Error('该地皮有多个建筑，请提供建筑实例编号')
      const target = instanceId ? buildings.find((b) => b.instanceId === instanceId) : buildings[0]
      if (!target) throw new Error('该地皮不存在指定建筑实例')
      if (target.type === 'residential' && !plot.isNewPlot) throw new Error('主住宅不可单独移动或拆除')
      return target
    }
    function protectFarmBeds(previous, updated) {
      const { savedBeds, farmLayout } = require('./playground-shared/farm-model')
      const beds = Object.values(savedBeds(previous))
      const available = new Set(farmLayout(updated).map((t) => t.id))
      if (beds.some((b) => !available.has(b.id))) throw new Error('建筑会占用已布置的植物，请先将对应土地恢复为草坪')
      updated.farmBeds = beds
      updated.gardenVersion = 2
    }
    function preserveRelocatedBeds(previous, updated) {
      if (!Array.isArray(previous.farmBeds) || !previous.farmBeds.length) return
      const { savedBeds, farmLayout } = require('./playground-shared/farm-model')
      const oldTiles = new Map(farmLayout(previous).map((t) => [t.id, t]))
      const pointKey = (x, z) => `${x.toFixed(6)},${z.toFixed(6)}`
      const newTiles = new Map(farmLayout(updated).map((t) => [pointKey(t.x - updated.x, t.z - updated.z), t]))
      updated.farmBeds = Object.values(savedBeds(previous)).map((bed) => {
        const old = oldTiles.get(bed.id)
        const tile = old && newTiles.get(pointKey(old.x - previous.x, old.z - previous.z))
        if (!tile) throw new Error('缩小后的庭院放不下已有农田，请先将对应土地恢复为草坪')
        return { ...bed, id: tile.id }
      })
      updated.gardenVersion = 2
    }
    async function saveBuildingPlot(tx, openid, updated, owner) {
      const { _id, ...clean } = updated
      await tx.collection('pet_playground_plots').doc(_id).set({ data: clean })
      if (owner && owner.plotId === _id) {
        await tx.collection('pet_playground_plots').doc(ownerId(openid)).set({
          data: { ...clean, kind: 'owner_plot', plotId: _id }
        })
      }
    }
    async function buildInYard(openid, user, data) {
      const targetPlotId = String(data.plotId || '')

      return transaction(db, async (tx) => {
        const catalog=await require('./playground-buildings')({db:tx}).readCatalog()
        const access=await memberAccess(tx,openid)
        const building=catalog.buildings.find((b)=>data.buildingId?b.id===data.buildingId:b.type===data.buildingType)
        if(!building||building.enabled===false||!unlocked(building,access))throw new Error('该建筑已下架或当前会员等级尚未解锁')
        const {id:buildingId,type:buildingType,category:buildingCategory,name:buildingName,image:buildingImage,width:buildingWidth,depth:buildingDepth}=building
        let targetPlot = null
        const ownerPlotDoc = await read(tx, ownerId(openid))
        const mainPlotId = ownerPlotDoc && !ownerPlotDoc.isNewPlot && !isPublicBuilding(ownerPlotDoc) ? ownerPlotDoc.plotId : null

        if (targetPlotId) {
          const doc = await read(tx, targetPlotId)
          if (!doc || doc.kind!=='plot' || doc.ownerOpenid!==openid || doc.demolished)throw new Error('只能在自己的有效地皮内建造')
          targetPlot = doc
        } else {
          const myPlots = await tx.collection('pet_playground_plots').where({ kind: 'plot', ownerOpenid: openid }).get()
          const plots = (myPlots.data || []).filter((p) => !p.demolished && (!data.sceneId || p.communityId === data.sceneId))
          targetPlot = !isPublicBuilding(building) && plots.find((p) => p._id === mainPlotId || !p.isNewPlot && !isPublicBuilding(p)) ||
            plots.find((p) => p._id !== mainPlotId && p.isNewPlot && (!isPublicBuilding(building) || !placedBuildings(p).some(isPublicBuilding)))
        }
        if (!targetPlot) {
          throw new Error('您当前没有空余的专属绿地！最初的自家庭院不可改建，请先认领一块新的专属绿地')
        }

        const communityId = targetPlot.communityId
        if(data.sceneId&&communityId!==data.sceneId)throw new Error('请回到该地皮所在小区建造')
        const buildings = placedBuildings(targetPlot)
        const instanceId = data.buildingInstanceId === undefined
          ? crypto.randomBytes(12).toString('hex') : String(data.buildingInstanceId || '')
        if (!instanceId || instanceId.length > 128) throw new Error('无效的建筑实例编号')
        const buildingX = Number(data.buildingX !== undefined ? data.buildingX : data.x !== undefined ? data.x : targetPlot.x)
        const buildingZ = Number(data.buildingZ !== undefined ? data.buildingZ : data.z !== undefined ? data.z : targetPlot.z)
        const prior = buildings.find((b) => b.instanceId === instanceId)
        if (prior) {
          if (prior.buildingId !== buildingId || prior.x !== buildingX || prior.z !== buildingZ)
            throw new Error('建筑实例编号冲突：已用于不同的建造意图')
          return publicPlot(withBuildings(targetPlot, buildings), openid)
        }
        const instance = { instanceId, buildingId, type: buildingType, category: buildingCategory || '',
          name: buildingName, image: buildingImage || '', width: Number(buildingWidth), depth: Number(buildingDepth),
          x: buildingX, z: buildingZ }
        const placementPlot = targetPlot._id === mainPlotId ? { ...targetPlot, isNewPlot: false } : targetPlot
        if (Math.max(instance.width, instance.depth) > (Number(targetPlot.size) || 48) - 2)
          throw new Error('这块绿地放不下该建筑')
        const placementError = validateBuildingPlacement(placementPlot, instance, instance)
        if (placementError) throw new Error(placementError)

        // 唯一性校验：居委会、督导所、自省室每个小区只能创建一个
        if (buildingType === 'committee') {
          const existingComm = await tx
            .collection('pet_playground_plots')
            .where({ kind:'plot',communityId, buildingType: 'committee' })
            .get()
          const active = (existingComm.data || []).find((p) => !p.demolished && p._id !== targetPlot._id)
          if (active) throw new Error('当前社区已设立居委会，每个社区有且仅能有一个居委会')
        }
        if (buildingType === 'police_station') {
          const existingPolice = await tx
            .collection('pet_playground_plots')
            .where({ kind:'plot',communityId, buildingType: 'police_station' })
            .get()
          const active = (existingPolice.data || []).find((p) => !p.demolished && p._id !== targetPlot._id)
          if (active) throw new Error('当前社区已设立文明督导所，每个社区有且仅能有一个文明督导所')
        }
        if (buildingType === 'prison') {
          const existingPrison = await tx
            .collection('pet_playground_plots')
            .where({ kind:'plot',communityId, buildingType: 'prison' })
            .get()
          const active = (existingPrison.data || []).find((p) => !p.demolished && p._id !== targetPlot._id)
          if (active) throw new Error('当前社区已设立安全宣教自省室，每个社区有且仅能有一个自省室')
        }

        const updated = withBuildings({ ...placementPlot,
          ...(buildingType === 'committee' ? { committeeStartedAt: stamp(), lastSalaryClaimAt: 0,
            committeeRevoked: false, revokedAt: 0, revokedReason: '' } : {}),
          revision: Math.max(stamp(), (targetPlot.revision || 0) + 1), updatedAt: nowText()
        }, [...buildings, instance])
        protectFarmBeds(targetPlot, updated)
        await saveBuildingPlot(tx, openid, updated, ownerPlotDoc)
        return publicPlot(updated, openid)
      })
    }
    async function dismantleBuilding(openid, user, data) {
      const targetPlotId = String(data.plotId || '')
      if (!targetPlotId) throw new Error('缺少地皮编号')

      return transaction(db, async (tx) => {
        const doc = await read(tx, targetPlotId)
        if (!doc || doc.kind !== 'plot' || doc.ownerOpenid !== openid || doc.demolished) {
          throw new Error('只能拆除自己名下的有效建筑')
        }

        if (data.sceneId && doc.communityId !== data.sceneId) throw new Error('请回到该地皮所在小区拆除建筑')
        const ownerPlotDoc = await read(tx, ownerId(openid))
        const buildings = placedBuildings(doc)
        const target = selectBuilding(doc, buildings, data.buildingInstanceId)
        const home = !doc.isNewPlot && ownerPlotDoc && ownerPlotDoc.plotId === doc._id
        const updated = withBuildings({ ...doc, ...(home ? { isNewPlot: false } : {}),
          previousBuildingType: target.type,
          ...(target.type === 'committee' ? { committeeStartedAt: 0, lastSalaryClaimAt: 0,
            committeeRevoked: false, revokedAt: 0, revokedReason: '' } : {}),
          updatedAt: nowText(), revision: Math.max(stamp(), (doc.revision || 0) + 1)
        }, buildings.filter((b) => b.instanceId !== target.instanceId))
        await saveBuildingPlot(tx, openid, updated, ownerPlotDoc)
        if (target.type === 'prison') await releasePrisonersIfPrisonRemoved(tx, doc.communityId, stamp())
        return {
          dismantled: true, plotId: doc._id, buildingInstanceId: target.instanceId,
          plot: publicPlot(updated, openid),
          message: `已成功拆除【${target.name || '建筑'}】，${updated.isNewPlot && !updated.buildings.length ? '地皮已恢复为初始草块' : '其他建筑和庭院保持不变'}！`
        }
      })
    }
    async function relocateBuilding(openid, user, data) {
      const plotId = String(data.plotId || '')
      if (!plotId) throw new Error('缺少地块编号')
      const targetX = Number(data.buildingX !== undefined ? data.buildingX : data.x)
      const targetZ = Number(data.buildingZ !== undefined ? data.buildingZ : data.z)
      if (!Number.isFinite(targetX) || !Number.isFinite(targetZ)) {
        throw new Error('无效的目标坐标')
      }

      return transaction(db, async (tx) => {
        const plot = await read(tx, plotId)
        if (!plot || plot.kind !== 'plot' || plot.ownerOpenid !== openid || plot.demolished) {
          throw new Error('只能调整自己地皮内的建筑位置')
        }
        if (data.sceneId && plot.communityId !== data.sceneId) throw new Error('请回到该地皮所在小区调整建筑')
        const ownerPlotDoc = await read(tx, ownerId(openid))
        const buildings = placedBuildings(plot)
        const target = selectBuilding(plot, buildings, data.buildingInstanceId)
        const home = !plot.isNewPlot && ownerPlotDoc && ownerPlotDoc.plotId === plot._id
        const placementPlot = home ? { ...plot, isNewPlot: false } : plot
        const error = validateBuildingPlacement(placementPlot, target, { x: targetX, z: targetZ }, target.instanceId)
        if (error) throw new Error(error)
        const updatedPlot = withBuildings({ ...placementPlot,
          revision: Math.max(stamp(), (plot.revision || 0) + 1), updatedAt: nowText()
        }, buildings.map((b) => b.instanceId === target.instanceId ? { ...b, x: targetX, z: targetZ } : b))
        protectFarmBeds(plot, updatedPlot)
        await saveBuildingPlot(tx, openid, updatedPlot, ownerPlotDoc)
        return publicPlot(updatedPlot, openid)
      })
    }
    async function ownInTransaction(tx, openid) { return resolveOwnerPlot(tx, openid) }
    return { config, own, claim, buildInYard, relocateBuilding, dismantleBuilding, region, mapOverview, publicPlot, ensureNameColors, fillBowl, demolish, ownInTransaction }
  }
}
