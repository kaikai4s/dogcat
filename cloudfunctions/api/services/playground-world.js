const { transaction } = require('./playground-transaction')
const crypto = require('crypto')
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
    foodBowls: { dog: plot.foodBowls && plot.foodBowls.dog === 100 ? 100 : 0 },
    ownerName: plot.ownerName || String(plot.name || '邻居').replace(/的庭院$/, ''),
    ownerId: 'presence_' + hash(plot.ownerOpenid),
    instanceId: plot.instanceId || plot.createdAt || '',
    name: plot.name || '邻居庭院'
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
  hash,
  readDocument,
  updateCommunity,
  allowRelocation,
  create({ db, nowText, nowMs }) {
    const stamp=()=>nowMs?nowMs():Date.now()
    async function config() {
      return {
        ...dimensions(),
        ...((await read(db, CONFIG_ID)) || {}),
        plotSize: SIZE,
        step: STEP,
        chunkSize: CHUNK,
        canRelocate: allowRelocation()
      }
    }
    async function own(openid) {
      return read(db, ownerId(openid))
    }
    async function fillBowl(openid, data) {
      if (typeof data.plotId !== 'string' || !data.plotId.trim())
        throw new Error('请选择自己的狗碗')
      return transaction(db,async (tx) => {
        const plot = await read(tx, ownerId(openid))
        if (!plot || plot.ownerOpenid !== openid || plot.plotId !== data.plotId)
          throw new Error('只能给自己庭院里的狗碗添粮，请重新进入庭院')
        // Filling is idempotent and has no currency or inventory reward.
        if (!plot.foodBowls || plot.foodBowls.dog !== 100) {
          const canonical = await read(tx, plot.plotId)
          await tx.collection('pet_playground_plots').doc(ownerId(openid)).update({
            data: { foodBowls: { dog: 100 }, updatedAt: nowText(),revision:Math.max(stamp(),(plot.revision||0)+1) }
          })
          if (canonical) await tx.collection('pet_playground_plots').doc(plot.plotId).update({
            data: { foodBowls: { dog: 100 }, updatedAt: nowText(),revision:Math.max(stamp(),(canonical.revision||0)+1) }
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
        if (
          existing &&
          existing.communityId === id &&
          existing.x === px &&
          existing.z === pz &&
          existing.size === SIZE
        ) {
          return publicPlot({ ...existing, _id: existing.plotId }, openid)
        }
        if (existing && !allowRelocation())
          throw new Error('你已经选择过房屋位置，不能更改')
        if (existing && existing.communityId !== id)
          throw new Error('只能在原小区调整庭院位置')
        const { _id: configDocumentId, ...stored } =
          (await read(tx, CONFIG_ID)) || {}
        const settings = { ...dimensions(), ...stored }
        if (
          px - SIZE / 2 < 0 ||
          pz - SIZE / 2 < 0 ||
          px + SIZE / 2 > settings.width ||
          pz + SIZE / 2 > settings.height
        )
          throw new Error('宅基地不能超过场景边界')
        const key = plotId(id, x, z)
        // Keep operations on one transaction ordered; viewport reads outside
        // transactions can still run concurrently.
        const reach = SIZE + GAP
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
            if (!other || other.ownerOpenid === openid) continue
            const separation = (SIZE + (Number(other.size) || 48)) / 2 + GAP
            if (
              other._id === key ||
              (Math.abs(px - other.x) < separation &&
                Math.abs(pz - other.z) < separation)
            )
              throw new Error('庭院范围与邻居重叠，请选择更空旷的草坪')
          }
        }
        const plot = {
          kind: 'plot',
          communityId: id,
          ownerOpenid: openid,
          cellX: x,
          cellZ: z,
          x: px,
          z: pz,
          size: SIZE,
          ownerName: String(user.nickname || '我').slice(0, 20),
          revision: Math.max(await require('./playground-live')({db,nowMs}).nextEpoch(id,key,stamp()),(existing&&existing.revision||0)+1),
          instanceId: crypto.randomBytes(12).toString('hex'),
          name: `${String(user.nickname || '我').slice(0, 20)}的庭院`,
          createdAt: existing ? existing.createdAt : nowText(),
          updatedAt: nowText()
        }
        if (existing && existing.plotId !== key)
          await tx
            .collection('pet_playground_plots')
            .doc(existing.plotId)
            .remove()
        await tx.collection('pet_playground_plots').doc(key).set({ data: plot })
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
        plots: rows.filter(Boolean).map((p) => publicPlot(p, openid)),
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
        plots: rows.filter((p) => !p.plotId).map((p) => publicPlot(p, openid)),
        nextCursor: rows.length === 100 ? rows[rows.length - 1]._id : ''
      }
    }
    async function demolish(openid, data) {
      return transaction(db,async (tx) => {
        const plot = await ownInTransaction(tx, openid)
        if (!plot || plot.ownerOpenid !== openid || data.plotId !== plot.plotId)
          throw new Error('只能拆除自己的当前庭院')
        if (data.sceneId && plot.communityId !== data.sceneId) throw new Error('请回到原小区拆除庭院')
        const residentId = 'resident_' + hash(openid)
        const resident = await read(tx, residentId)
        const presenceId = 'presence_' + hash(openid)
        const presence = await read(tx, presenceId)
        await tx.collection('pet_playground_plots').doc(plot.plotId).remove()
        await tx.collection('pet_playground_plots').doc(ownerId(openid)).remove()
        if (resident) await tx.collection('pet_playground_plots').doc(residentId).remove()
        if (presence) await tx.collection('pet_playground_plots').doc(presenceId).remove()
        return { removed: true }
      })
    }
    async function ownInTransaction(tx, openid) { return read(tx, ownerId(openid)) }
    return { config, own, claim, region, mapOverview, publicPlot, fillBowl, demolish }
  }
}
