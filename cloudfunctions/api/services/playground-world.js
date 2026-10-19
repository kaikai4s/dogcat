const { transaction } = require('./playground-transaction')
const crypto = require('crypto')
const nameColors = require('./playground-name-colors')
const SIZE = 112
const STEP = 56
const GAP = 4
const DEFAULT_PLOT_SIZES = [
  { size: 36, label: '紧凑庭院 (36×36m)', price: 30 },
  { size: 48, label: '标准庭院 (48×48m)', price: 50 },
  { size: 64, label: '宽敞庭院 (64×64m)', price: 80 },
  { size: 80, label: '豪华庄园 (80×80m)', price: 120 }
]
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
    farmBeds: Array.isArray(plot.farmBeds) ? plot.farmBeds : [],
    ownerName: plot.ownerName || String(plot.name || '邻居').replace(/的庭院$/, ''),
    nameColor: plot.nameColor || '',
    ownerId: 'presence_' + hash(plot.ownerOpenid),
    instanceId: plot.instanceId || plot.createdAt || '',
    gateDirection: plot.gateDirection || 'south',
    name: plot.name || '邻居庭院',
    buildingId: plot.buildingId || '',
    buildingType: plot.buildingType || 'residential',
    buildingName: plot.buildingName || '',
    buildingImage: plot.buildingImage || '',
    buildingWidth: Number(plot.buildingWidth) || 0,
    buildingDepth: Number(plot.buildingDepth) || 0,
    isNewPlot: Boolean(plot.isNewPlot)
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
  DEFAULT_PLOT_SIZES,
  read,
  dimensions,
  communityId,
  ownerId,
  plotId,
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
        plotSizes: stored.plotSizes || DEFAULT_PLOT_SIZES,
        step: STEP,
        chunkSize: CHUNK,
        canRelocate: allowRelocation()
      }
    }
    async function own(openid) {
      const plot = await read(db, ownerId(openid))
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
        const existing = await read(tx, ownerId(openid))
        const nameColor = await nameColors.allocate(tx, id, hash(openid), read)
        const reqSize = Number(data.size)
        const allowedSizes = [36, 48, 64, 80, 112]
        const plotSize = allowedSizes.includes(reqSize) ? reqSize : SIZE

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

        // 购买新地皮扣减爱心币
        const sizeOption = DEFAULT_PLOT_SIZES.find((o) => o.size === plotSize)
        const defaultCost = sizeOption ? sizeOption.price : 50
        const costCoins = isNewPlot ? (data.costCoins !== undefined ? Math.max(0, Number(data.costCoins)) : defaultCost) : 0
        if (isNewPlot && costCoins > 0) {
          const userCoins = current.playgroundCoins || 0
          if (userCoins < costCoins) {
            throw new Error(`爱心币不足，购买 ${plotSize}×${plotSize} 米独立地皮需要 ${costCoins} 爱心币，当前拥有 ${userCoins} 爱心币`)
          }
          await tx.collection('users').doc(user._id).update({
            data: {
              playgroundCoins: userCoins - costCoins
            }
          })
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
            if (!isNewPlot && other.ownerOpenid === openid) continue
            const separation = (plotSize + (Number(other.size) || 48)) / 2 + GAP
            if (
              other._id === key ||
              (Math.abs(px - other.x) < separation &&
                Math.abs(pz - other.z) < separation)
            )
              throw new Error('地皮范围与已有建筑或邻居重叠，请选择更空旷的草坪')
          }
        }
        const buildingType = data.buildingType || (isNewPlot ? 'yard' : (existing && existing.buildingType) || 'residential')
        const buildingId = data.buildingId || (existing && existing.buildingId) || ''
        const buildingName = data.buildingName || (existing && existing.buildingName) || ''
        const buildingImage = data.buildingImage || (existing && existing.buildingImage) || ''
        const buildingWidth = Number(data.buildingWidth) || (existing && existing.buildingWidth) || 7
        const buildingDepth = Number(data.buildingDepth) || (existing && existing.buildingDepth) || 7

        const plot = {
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
          buildingName,
          buildingImage,
          buildingWidth,
          buildingDepth,
          ownerName: String(user.nickname || '我').slice(0, 20),
          nameColor,
          revision: Math.max(await require('./playground-live')({db,nowMs}).nextEpoch(id,key,stamp()),(existing&&existing.revision||0)+1),
          instanceId: crypto.randomBytes(12).toString('hex'),
          name: buildingName ? `${String(user.nickname || '我').slice(0, 20)}的${buildingName}` : (isNewPlot ? `${String(user.nickname || '我').slice(0, 20)}的专属地皮` : `${String(user.nickname || '我').slice(0, 20)}的庭院`),
          createdAt: existing ? existing.createdAt : nowText(),
          updatedAt: nowText(),
          isNewPlot: Boolean(isNewPlot)
        }
        // 若为购买新地皮，绝不删除原有的老庭院！原别墅完整保留在原位
        if (!isNewPlot && existing && existing.plotId !== key)
          await tx
            .collection('pet_playground_plots')
            .doc(existing.plotId)
            .remove()
        await tx.collection('pet_playground_plots').doc(key).set({ data: plot })
        // 仅在首次建造主庭院或主动调整主庭院时，更新主庭院映射
        if (!existing || !isNewPlot)
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
        plots: (await ensureNameColors(rows.filter(Boolean))).map((p) => publicPlot(p, openid)),
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
        plots: (await ensureNameColors(rows.filter((p) => !p.plotId))).map((p) => publicPlot(p, openid)),
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
        await tx.collection('pet_playground_plots').doc(plot.plotId).remove()
        await tx.collection('pet_playground_plots').doc(ownerId(openid)).remove()
        if (resident) await tx.collection('pet_playground_plots').doc(residentId).remove()
        if (presence) await tx.collection('pet_playground_plots').doc(presenceId).remove()
        const carId='vehicle_'+hash(openid)
        if(await read(tx,carId))await tx.collection('pet_playground_plots').doc(carId).remove()
        return beforeRemove?{ removed: true,released }:{ removed: true }
      })
    }
    async function buildInYard(openid, user, data) {
      const buildingId = String(data.buildingId || '')
      const buildingType = String(data.buildingType || 'residential')
      const buildingName = String(data.buildingName || '')
      const buildingImage = String(data.buildingImage || '')
      const buildingWidth = Number(data.buildingWidth) || 7
      const buildingDepth = Number(data.buildingDepth) || 7
      const costCoins = Math.max(0, Number(data.costCoins) || 0)
      const targetPlotId = String(data.plotId || '')

      return transaction(db, async (tx) => {
        let targetPlot = null
        if (targetPlotId) {
          const doc = await read(tx, targetPlotId)
          if (doc && doc.ownerOpenid === openid) {
            targetPlot = doc
          }
        }
        if (!targetPlot) {
          const ownerPlotDoc = await read(tx, ownerId(openid))
          if (ownerPlotDoc && ownerPlotDoc.plotId) {
            targetPlot = await read(tx, ownerPlotDoc.plotId)
          }
        }
        if (!targetPlot) {
          throw new Error('您还没有属于自己的地皮，房子的建筑只能在已购买的地皮内部建造，请先购买地皮')
        }

        const communityId = targetPlot.communityId

        // 唯一性校验：居委会、督导所、自省室每个小区只能创建一个
        if (buildingType === 'committee') {
          const existingComm = await tx
            .collection('pet_playground_plots')
            .where({ communityId, buildingType: 'committee' })
            .get()
          const active = (existingComm.data || []).find((p) => !p.demolished && p._id !== targetPlot._id)
          if (active) throw new Error('当前社区已设立居委会，每个社区有且仅能有一个居委会')
        }
        if (buildingType === 'police_station') {
          const existingPolice = await tx
            .collection('pet_playground_plots')
            .where({ communityId, buildingType: 'police_station' })
            .get()
          const active = (existingPolice.data || []).find((p) => !p.demolished && p._id !== targetPlot._id)
          if (active) throw new Error('当前社区已设立文明督导所，每个社区有且仅能有一个文明督导所')
        }
        if (buildingType === 'prison') {
          const existingPrison = await tx
            .collection('pet_playground_plots')
            .where({ communityId, buildingType: 'prison' })
            .get()
          const active = (existingPrison.data || []).find((p) => !p.demolished && p._id !== targetPlot._id)
          if (active) throw new Error('当前社区已设立安全宣教自省室，每个社区有且仅能有一个自省室')
        }

        // 扣减爱心币购买建筑
        if (costCoins > 0) {
          const currentUser = await readDocument(tx, 'users', user._id, '读取用户')
          const userCoins = (currentUser && currentUser.playgroundCoins) || 0
          if (userCoins < costCoins) {
            throw new Error(`爱心币不足，建造该建筑需要 ${costCoins} 爱心币，当前拥有 ${userCoins} 爱心币`)
          }
          await tx.collection('users').doc(user._id).update({
            data: { playgroundCoins: userCoins - costCoins }
          })
        }

        const updated = {
          ...targetPlot,
          buildingId,
          buildingType,
          buildingName,
          buildingImage,
          buildingWidth,
          buildingDepth,
          name: buildingName ? `${String(user.nickname || '我').slice(0, 20)}的${buildingName}` : `${String(user.nickname || '我').slice(0, 20)}的庭院`,
          updatedAt: nowText()
        }

        const { _id, ...cleanUpdated } = updated
        await tx.collection('pet_playground_plots').doc(targetPlot._id).set({ data: cleanUpdated })
        const mainOwner = await read(tx, ownerId(openid))
        if (mainOwner && mainOwner.plotId === targetPlot._id) {
          await tx.collection('pet_playground_plots').doc(ownerId(openid)).set({ data: { ...cleanUpdated, kind: 'owner_plot', plotId: targetPlot._id } })
        }
        return publicPlot({ ...cleanUpdated, _id: targetPlot._id }, openid)
      })
    }
    async function ownInTransaction(tx, openid) { return read(tx, ownerId(openid)) }
    return { config, own, claim, buildInYard, region, mapOverview, publicPlot, ensureNameColors, fillBowl, demolish }
  }
}
